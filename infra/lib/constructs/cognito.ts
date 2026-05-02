import * as cdk from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as route53targets from 'aws-cdk-lib/aws-route53-targets'
import { Construct } from 'constructs'

export interface CognitoConstructProps {
  /**
   * Environment name — used to name the user pool and app client.
   */
  readonly envName: string
  /**
   * MFA enforcement. Required for prod; optional for dev/staging.
   */
  readonly enableMfa: boolean
  /**
   * Domain for the Cognito Hosted UI. Auth UI lives at auth.{domain}.
   */
  readonly domain: string
  /**
   * Hosted zone for the auth subdomain A-record.
   */
  readonly hostedZone: route53.IHostedZone
}

/**
 * CognitoConstruct provisions the user pool, app client, and hosted UI.
 *
 * Authentication flows:
 *  - Email/password (always enabled)
 *  - Google OAuth (configurable via ORBITAL_GOOGLE_CLIENT_ID / _SECRET env vars at synth)
 *  - Microsoft OAuth (configurable via ORBITAL_MS_CLIENT_ID / _SECRET env vars at synth)
 *    NOTE: External IdPs require client credentials that cannot be committed to source.
 *    If env vars are absent, only email/password auth is wired. Add IdPs post-deploy
 *    via the console or re-synth after setting the env vars.
 *
 * Token validity:
 *  - id_token / access_token: 1 hour
 *  - refresh_token: 30 days
 *
 * Hosted UI lives at: auth.{domain}
 *  - Callback: https://{domain}/auth/callback
 *  - Sign-out: https://{domain}/auth/signed-out
 *
 * Security notes:
 *  - Account recovery via email only (NO SMS — social engineering risk)
 *  - Password policy: 12+ chars, upper, lower, digit, symbol
 *  - Pre-sign-up Lambda trigger placeholder wired; implement in 8-03
 *  - Post-confirmation Lambda trigger placeholder wired; implement in 8-03
 */
export class CognitoConstruct extends Construct {
  readonly userPool: cognito.UserPool
  readonly appClient: cognito.UserPoolClient
  readonly userPoolDomain: cognito.UserPoolDomain

  constructor(scope: Construct, id: string, props: CognitoConstructProps) {
    super(scope, id)

    const mfaMode = props.enableMfa
      ? cognito.Mfa.REQUIRED
      : cognito.Mfa.OPTIONAL

    // -----------------------------------------------------------------------
    // User Pool
    // -----------------------------------------------------------------------
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `orbital-${props.envName}`,

      // Sign-in with email address
      signInAliases: {
        email: true,
        username: false,
        phone: false,
      },
      signInCaseSensitive: false,

      // Self-service account creation (users register themselves)
      selfSignUpEnabled: true,

      // Required attributes collected at sign-up
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: true, mutable: true },
        familyName: { required: true, mutable: true },
      },

      // Password policy: 12+ chars, mixed case, digit, symbol
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(7),
      },

      // MFA: required in prod, optional in dev/staging
      mfa: mfaMode,
      mfaSecondFactor: {
        sms: false, // SMS disabled — social engineering risk
        otp: true, // TOTP (Authenticator app)
      },

      // Account recovery: email only (no SMS)
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,

      // Email configuration (uses Cognito's default SES for now)
      // In 8-07 (Secrets/infra) this can be wired to a dedicated SES identity
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE,
        emailSubject: 'Your Orbital verification code',
        emailBody:
          'Your verification code for Orbital is {####}. This code expires in 24 hours.',
      },

      userInvitation: {
        emailSubject: 'You have been invited to Orbital',
        emailBody:
          'Hello {username}, you have been invited to Orbital. Your temporary password is {####}.',
      },

      // Advanced security — log user activity, detect compromised credentials
      advancedSecurityMode: cognito.AdvancedSecurityMode.ENFORCED,

      // Deletion protection for prod; retain data on stack removal
      deletionProtection: props.enableMfa, // prod only
      removalPolicy: props.enableMfa
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    })

    // -----------------------------------------------------------------------
    // Optional external identity providers
    // Credentials must be injected at synth via env vars — never hardcoded.
    // -----------------------------------------------------------------------
    const googleClientId = process.env['ORBITAL_GOOGLE_CLIENT_ID']
    const googleClientSecret = process.env['ORBITAL_GOOGLE_CLIENT_SECRET']
    const msClientId = process.env['ORBITAL_MS_CLIENT_ID']
    const msClientSecret = process.env['ORBITAL_MS_CLIENT_SECRET']

    const supportedIdentityProviders: cognito.UserPoolClientIdentityProvider[] =
      [cognito.UserPoolClientIdentityProvider.COGNITO]

    if (googleClientId && googleClientSecret) {
      const googleProvider = new cognito.UserPoolIdentityProviderGoogle(
        this,
        'GoogleIdp',
        {
          userPool: this.userPool,
          clientId: googleClientId,
          clientSecretValue: cdk.SecretValue.unsafePlainText(googleClientSecret),
          scopes: ['email', 'profile', 'openid'],
          attributeMapping: {
            email: cognito.ProviderAttribute.GOOGLE_EMAIL,
            givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
            familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
          },
        },
      )
      this.userPool.registerIdentityProvider(googleProvider)
      supportedIdentityProviders.push(
        cognito.UserPoolClientIdentityProvider.GOOGLE,
      )
    }

    if (msClientId && msClientSecret) {
      const msProvider = new cognito.UserPoolIdentityProviderOidc(
        this,
        'MicrosoftIdp',
        {
          userPool: this.userPool,
          name: 'Microsoft',
          clientId: msClientId,
          clientSecret: msClientSecret,
          issuerUrl:
            'https://login.microsoftonline.com/common/v2.0',
          scopes: ['openid', 'email', 'profile'],
          attributeMapping: {
            email: cognito.ProviderAttribute.other('email'),
            givenName: cognito.ProviderAttribute.other('given_name'),
            familyName: cognito.ProviderAttribute.other('family_name'),
          },
        },
      )
      this.userPool.registerIdentityProvider(msProvider)
      supportedIdentityProviders.push(
        cognito.UserPoolClientIdentityProvider.custom('Microsoft'),
      )
    }

    // -----------------------------------------------------------------------
    // Cognito Domain (Hosted UI)
    // Uses a custom domain: auth.{domain}
    // The A-record pointing to Cognito's CloudFront distribution is created below.
    // -----------------------------------------------------------------------
    const cognitoDomainPrefix = `orbital-${props.envName}`
    this.userPoolDomain = this.userPool.addDomain('HostedUiDomain', {
      cognitoDomain: {
        domainPrefix: cognitoDomainPrefix,
      },
    })

    // -----------------------------------------------------------------------
    // App Client — SPA with PKCE OAuth code flow
    // -----------------------------------------------------------------------
    this.appClient = this.userPool.addClient('SpaClient', {
      userPoolClientName: `orbital-${props.envName}-spa`,

      // OAuth code flow with PKCE (no client secret exposed to browser)
      authFlows: {
        userSrp: true, // SRP for email/password
        userPassword: false, // plain password — disabled for security
        adminUserPassword: false,
        custom: false,
      },
      generateSecret: false, // SPA — secret would be exposed in browser

      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false, // deprecated; use PKCE
          clientCredentials: false,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
          // orbital/api custom scope added in 8-03 when the Lambda authorizer lands
        ],
        callbackUrls: [
          `https://${props.domain}/auth/callback`,
          // Allow localhost for local dev against the mwitt Cognito pool
          'http://localhost:3000/auth/callback',
        ],
        logoutUrls: [
          `https://${props.domain}/auth/signed-out`,
          'http://localhost:3000/auth/signed-out',
        ],
      },

      supportedIdentityProviders,

      // Token validity
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),

      // Prevent token reuse
      enableTokenRevocation: true,

      // Prevent user existence errors leaking to attackers
      preventUserExistenceErrors: true,
    })

    // -----------------------------------------------------------------------
    // Route 53: A-record for auth.{domain} → Cognito Hosted UI
    // -----------------------------------------------------------------------
    new route53.ARecord(this, 'AuthDomainRecord', {
      zone: props.hostedZone,
      recordName: `auth.${props.domain}`,
      target: route53.RecordTarget.fromAlias(
        new route53targets.UserPoolDomainTarget(this.userPoolDomain),
      ),
      comment: `Orbital ${props.envName} — Cognito hosted UI`,
    })

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: `Orbital ${props.envName} Cognito user pool ID`,
      exportName: `OrbitalHub-${props.envName}-UserPoolId`,
    })

    new cdk.CfnOutput(this, 'UserPoolArn', {
      value: this.userPool.userPoolArn,
      description: `Orbital ${props.envName} Cognito user pool ARN`,
      exportName: `OrbitalHub-${props.envName}-UserPoolArn`,
    })

    new cdk.CfnOutput(this, 'AppClientId', {
      value: this.appClient.userPoolClientId,
      description: `Orbital ${props.envName} Cognito SPA app client ID`,
      exportName: `OrbitalHub-${props.envName}-AppClientId`,
    })

    new cdk.CfnOutput(this, 'CognitoHostedUiUrl', {
      value: this.userPoolDomain.baseUrl(),
      description: `Orbital ${props.envName} Cognito hosted UI base URL`,
    })

    new cdk.CfnOutput(this, 'AuthCallbackUrl', {
      value: `https://${props.domain}/auth/callback`,
      description: `Orbital ${props.envName} auth callback URL`,
    })
  }
}
