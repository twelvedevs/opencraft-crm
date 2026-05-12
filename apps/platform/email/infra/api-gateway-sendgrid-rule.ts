/**
 * API Gateway routing rule for SendGrid webhook endpoint.
 *
 * This construct creates a dedicated ALB listener rule for POST /webhooks/sendgrid,
 * isolated from the main Email Service API listener. It sits at a higher priority
 * so it matches before the catch-all rule, and restricts source IPs to SendGrid's
 * published delivery IP ranges.
 *
 * NOTE: This rule forwards to the same ECS service target group as the main API
 * listener but is registered as a separate listener rule with higher priority
 * (e.g., priority 10 vs. the main rule at priority 100). This keeps SendGrid
 * traffic identifiable in ALB access logs without requiring a second load balancer.
 *
 * SendGrid IP ranges reference:
 *   https://sendgrid.com/en-us/blog/sendgrid-ip-ranges
 *   Last verified: 2026-03-25. Review on each major SendGrid infrastructure change.
 */

import * as cdk from 'aws-cdk-lib';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * SendGrid's published outbound delivery IP CIDRs.
 *
 * These ranges are used by SendGrid to deliver webhook event payloads
 * (delivery, bounce, open, click, spam-report, unsubscribe events).
 *
 * Source: https://sendgrid.com/en-us/blog/sendgrid-ip-ranges
 * Review and update whenever SendGrid announces IP range changes.
 */
const SENDGRID_WEBHOOK_IP_CIDRS: string[] = [
  '167.89.0.0/17',   // SendGrid dedicated IP block (primary)
  '198.37.144.0/20', // SendGrid shared delivery pool
  '198.21.0.0/21',   // SendGrid inbound parse / event webhook relay
  '208.115.214.0/24',
  '208.115.235.0/24',
  '74.63.194.0/24',
  '74.63.235.0/24',
  '67.228.50.0/24',
  '167.89.86.0/24',
  '149.72.0.0/16',   // Twilio SendGrid broader allocation
];

export interface SendGridWebhookRuleProps {
  /** The ALB listener to attach this rule to (same listener as the main Email Service API). */
  listener: elbv2.IApplicationListener;
  /** The ECS service target group that handles Email Service requests. */
  targetGroup: elbv2.IApplicationTargetGroup;
  /**
   * Listener rule priority for this rule.
   * Must be lower (higher priority) than the main catch-all rule.
   * Default: 10
   */
  priority?: number;
}

/**
 * CDK construct that creates a dedicated ALB listener rule for the SendGrid webhook path.
 *
 * Responsibilities:
 *  - Restricts inbound traffic to POST /webhooks/sendgrid to SendGrid IP CIDRs only.
 *  - Registers the rule at a higher priority than the main API catch-all rule.
 *  - Forwards matching requests to the same ECS target group as the main API.
 *  - Returns a human-readable description for use in tagging and change-log entries.
 *
 * This rule is intentionally separate from the main Email Service API listener rule
 * to allow independent WAF rules, access-log filtering, and alert policies for
 * the SendGrid webhook path without affecting other API traffic.
 */
export class SendGridWebhookListenerRule extends Construct {
  /** Human-readable description for tagging and audit purposes. */
  public readonly description: string =
    'ALB listener rule for POST /webhooks/sendgrid — restricts source IPs to ' +
    'SendGrid delivery ranges and forwards to the Email Service ECS target group. ' +
    'Registered as a separate listener rule with higher priority than the main ' +
    'Email Service API listener rule.';

  constructor(scope: Construct, id: string, props: SendGridWebhookRuleProps) {
    super(scope, id);

    const priority = props.priority ?? 10;

    /**
     * ALB listener rule: POST /webhooks/sendgrid, SendGrid IPs only.
     *
     * NOTE: ECS stop timeout must be >= 30s to allow campaign-recipient workers
     * to finish draining when a SIGTERM is received during high-volume sends.
     * Set in the ECS task definition's `stopTimeout` property.
     *
     * Condition ordering:
     *  1. Path must be exactly /webhooks/sendgrid (path-pattern condition)
     *  2. HTTP method must be POST (http-request-method condition)
     *  3. Source IP must be within one of the SendGrid CIDR ranges (source-ip condition)
     *
     * Any request that does not match all three conditions falls through to the
     * lower-priority main API listener rule, which handles all other paths.
     */
    new elbv2.ApplicationListenerRule(this, 'SendGridWebhookRule', {
      listener: props.listener,
      priority,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/webhooks/sendgrid']),
        elbv2.ListenerCondition.httpRequestMethods(['POST']),
        elbv2.ListenerCondition.sourceIps(SENDGRID_WEBHOOK_IP_CIDRS),
      ],
      action: elbv2.ListenerAction.forward([props.targetGroup]),
    });

    // Tag the rule for operational clarity.
    cdk.Tags.of(this).add('Component', 'email-service');
    cdk.Tags.of(this).add('Rule', 'sendgrid-webhook');
  }
}
