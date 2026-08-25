#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { UbeeqStack } from '../lib/ubeeq-stack';
import { BlueskyOAuthStack, type PublicBrand, PublicLandingStack, publicLaunchStackName } from '../lib/public-launch-stack';
import { LAUNCH_REGIONS, RegionalCellStack, type ManagedProduct } from '../lib/regional-cell-stack';

const app = new cdk.App();
const environment = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ca-central-1'
  }
};
const deployTarget = app.node.tryGetContext('deployTarget') || process.env.DEPLOY_TARGET || 'full';

if (deployTarget === 'regional-cell') {
  const product = process.env.PRODUCT as ManagedProduct | undefined;
  const cellEnvironment = process.env.ENVIRONMENT?.trim();
  const dataHomeRegion = process.env.DATA_HOME_REGION as typeof LAUNCH_REGIONS[number] | undefined;
  if (!product || !['eversally', 'nightframe'].includes(product) || !cellEnvironment || !dataHomeRegion || !LAUNCH_REGIONS.includes(dataHomeRegion)) {
    throw new Error('Regional cells require PRODUCT=eversally|nightframe, ENVIRONMENT, and an approved DATA_HOME_REGION');
  }
  new RegionalCellStack(app, `${product}-${cellEnvironment}-${dataHomeRegion}`, { product, environment: cellEnvironment, dataHomeRegion, ffmpegLayerArn: process.env.FFMPEG_LAYER_ARN?.trim(), regionalPolicyProfileJson: process.env.REGIONAL_POLICY_PROFILE_JSON?.trim(), env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: dataHomeRegion } });
} else if (deployTarget === 'public') {
  const brand: PublicBrand = process.env.PRODUCT_BRAND === 'ubeeq' ? 'ubeeq' : 'eversally';
  const rootDomain = process.env.ROOT_DOMAIN?.trim().toLowerCase();
  const apiDomain = process.env.API_DOMAIN?.trim().toLowerCase();
  const hostedZoneId = process.env.HOSTED_ZONE_ID?.trim();
  const webCertificateArn = process.env.WEB_CERTIFICATE_ARN?.trim();
  const apiCertificateArn = process.env.API_CERTIFICATE_ARN?.trim();
  const blueskyOAuthSecretName = process.env.BLUESKY_OAUTH_SECRET_NAME?.trim();
  const missing = [
    !rootDomain ? 'ROOT_DOMAIN' : '',
    !apiDomain ? 'API_DOMAIN' : '',
    !hostedZoneId ? 'HOSTED_ZONE_ID' : '',
    !webCertificateArn ? 'WEB_CERTIFICATE_ARN' : '',
    !apiCertificateArn ? 'API_CERTIFICATE_ARN' : '',
    !blueskyOAuthSecretName ? 'BLUESKY_OAUTH_SECRET_NAME' : ''
  ].filter(Boolean);
  if (missing.length) throw new Error(`Public launch deployment is incomplete: ${missing.join(', ')}`);
  const props = { ...environment, brand, rootDomain: rootDomain!, apiDomain: apiDomain!, hostedZoneId: hostedZoneId!, webCertificateArn: webCertificateArn!, apiCertificateArn: apiCertificateArn!, blueskyOAuthSecretName: blueskyOAuthSecretName! };
  new PublicLandingStack(app, publicLaunchStackName(brand, 'landing'), props);
  new BlueskyOAuthStack(app, publicLaunchStackName(brand, 'bluesky'), props);
} else {
  const stackName = app.node.tryGetContext('stackName') || process.env.STACK_NAME || 'UbeeqStack';
  new UbeeqStack(app, stackName, environment);
}
