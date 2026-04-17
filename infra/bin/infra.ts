#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GalleryStack } from '../lib/gallery-stack';
import { SyndicationSourceStack } from '../lib/syndication-source-stack';

const app = new cdk.App();
const galleryStackName = app.node.tryGetContext('galleryStackName') || process.env.GALLERY_STACK_NAME || 'GalleryStack';
const syndicationStackName = app.node.tryGetContext('syndicationStackName') || process.env.SYNDICATION_STACK_NAME || 'SyndicationSourceStack';

const galleryStack = new GalleryStack(app, galleryStackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ca-central-1'
  }
});

new SyndicationSourceStack(app, syndicationStackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ca-central-1'
  },
  userPool: galleryStack.userPool,
  userPoolClient: galleryStack.userPoolClient,
  galleryCoreTable: galleryStack.galleryCoreTable
});
