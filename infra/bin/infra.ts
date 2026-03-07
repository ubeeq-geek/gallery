#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GalleryStack } from '../lib/gallery-stack';

const app = new cdk.App();
new GalleryStack(app, 'GalleryStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ca-central-1'
  }
});
