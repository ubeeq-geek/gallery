#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StudioStack } from '../lib/studio-stack';

const app = new cdk.App();
const stackName = app.node.tryGetContext('stackName') || process.env.STACK_NAME || 'StudioStack';
new StudioStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ca-central-1'
  }
});
