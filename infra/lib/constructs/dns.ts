import * as cdk from 'aws-cdk-lib'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import { Construct } from 'constructs'

export interface DnsConstructProps {
  /**
   * The fully-qualified domain for this environment.
   * e.g. "mwitt.orbital.team.dev", "orbital.team.dev"
   */
  readonly domain: string
  /**
   * Environment name - used for resource naming.
   */
  readonly envName: string
  /**
   * When false, skip Route 53 hosted zone and ACM certificate creation.
   * hostedZone and certificate properties will be undefined.
   * Default: true (preserves existing behaviour for prod/rreed).
   */
  readonly useCustomDomain?: boolean
}

/**
 * DnsConstruct provisions Route 53 hosted zone and ACM wildcard certificate.
 *
 * When useCustomDomain=false (e.g. mwitt env), no Route 53 or ACM resources
 * are created. The hostedZone and certificate properties are undefined; callers
 * must guard on them before creating DNS-dependent resources.
 *
 * When useCustomDomain=true (default, prod/rreed):
 *
 * Hosted zone strategy:
 *  - If ORBITAL_HOSTED_ZONE_ID env var is set at synth time, imports the existing zone.
 *  - Otherwise creates a new hosted zone and outputs the NS records that the operator
 *    must delegate from the parent zone.
 *
 * Certificate:
 *  - Wildcard: *.{domain} - covers all subdomains including auth.{domain}
 *  - Validated via DNS (CNAME records auto-created in the hosted zone above)
 *  - us-east-1 cert is required for CloudFront; for non-us-east-1 regions the stack
 *    creates a cross-region reference. For simplicity in 8-01 we create the cert
 *    in the stack region; CloudFront cert will be handled in 8-06.
 *
 * Outputs:
 *  - HostedZoneId
 *  - CertificateArn
 *  - NameServers (if new zone created - operator must delegate)
 */
export class DnsConstruct extends Construct {
  /**
   * The Route 53 hosted zone. Undefined when useCustomDomain=false.
   */
  readonly hostedZone: route53.IHostedZone | undefined
  /**
   * The ACM wildcard certificate. Undefined when useCustomDomain=false.
   */
  readonly certificate: acm.Certificate | undefined
  readonly newZoneCreated: boolean

  constructor(scope: Construct, id: string, props: DnsConstructProps) {
    super(scope, id)

    const useCustomDomain = props.useCustomDomain ?? true

    if (!useCustomDomain) {
      // No Route 53, no ACM - AWS-generated URLs only.
      this.hostedZone = undefined
      this.certificate = undefined
      this.newZoneCreated = false
      return
    }

    const existingZoneId = process.env['ORBITAL_HOSTED_ZONE_ID']

    if (existingZoneId) {
      // Import existing hosted zone - no NS delegation needed
      this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(
        this,
        'HostedZone',
        {
          hostedZoneId: existingZoneId,
          zoneName: props.domain,
        },
      )
      this.newZoneCreated = false
    } else {
      // Create new hosted zone - operator must add NS records to parent zone
      const zone = new route53.HostedZone(this, 'HostedZone', {
        zoneName: props.domain,
        comment: `Orbital ${props.envName} - managed by CDK`,
      })
      this.hostedZone = zone
      this.newZoneCreated = true

      // Surface the NS records so the operator knows what to delegate
      new cdk.CfnOutput(this, 'NameServers', {
        value: cdk.Fn.join(', ', zone.hostedZoneNameServers ?? []),
        description: [
          `ACTION REQUIRED: Add these NS records to your parent zone for ${props.domain}.`,
          'Until delegation is complete, DNS validation and the ACM cert will not activate.',
        ].join(' '),
        exportName: `OrbitalHub-${props.envName}-NameServers`,
      })
    }

    // Wildcard ACM certificate - covers *.domain and domain itself
    // DNS validation auto-creates CNAME records in the hosted zone above.
    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domain,
      subjectAlternativeNames: [`*.${props.domain}`],
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
      certificateName: `orbital-${props.envName}`,
    })

    // Outputs
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: `Orbital ${props.envName} hosted zone ID`,
      exportName: `OrbitalHub-${props.envName}-HostedZoneId`,
    })

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      description: `Orbital ${props.envName} wildcard ACM cert ARN`,
      exportName: `OrbitalHub-${props.envName}-CertificateArn`,
    })
  }
}
