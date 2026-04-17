#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { GalleryStack } from '../lib/gallery-stack';
import { SyndicationSourceStack } from '../lib/syndication-source-stack';

const readExistingGalleryStackTargets = async (stackName: string, region: string) => {
  const client = new CloudFormationClient({ region });
  const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = response.Stacks?.[0];
  if (!stack) {
    throw new Error(`CloudFormation stack not found: ${stackName}`);
  }

  const outputs = new Map<string, string>();
  for (const output of stack.Outputs || []) {
    if (output.OutputKey && output.OutputValue) {
      outputs.set(output.OutputKey, output.OutputValue);
    }
  }

  const userPoolId = outputs.get('UserPoolId');
  const userPoolClientId = outputs.get('UserPoolClientId');
  const galleryCoreTableName = outputs.get('GalleryCoreTableName');

  if (!userPoolId || !userPoolClientId || !galleryCoreTableName) {
    throw new Error(
      `Stack ${stackName} is missing one or more required outputs: UserPoolId, UserPoolClientId, GalleryCoreTableName`
    );
  }

  return { userPoolId, userPoolClientId, galleryCoreTableName };
};

const main = async () => {
  const app = new cdk.App();
  const region = process.env.CDK_DEFAULT_REGION || 'ca-central-1';
  const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region
  };
  const galleryStackName = app.node.tryGetContext('galleryStackName') || process.env.GALLERY_STACK_NAME || 'GalleryStack';
  const syndicationStackName = app.node.tryGetContext('syndicationStackName') || process.env.SYNDICATION_STACK_NAME || 'SyndicationSourceStack';
  const existingGalleryStackName = app.node.tryGetContext('existingGalleryStackName') || process.env.EXISTING_GALLERY_STACK_NAME;

  if (existingGalleryStackName) {
    const existingTargets = await readExistingGalleryStackTargets(existingGalleryStackName, region);
    new SyndicationSourceStack(app, syndicationStackName, {
      env,
      userPoolId: existingTargets.userPoolId,
      userPoolClientId: existingTargets.userPoolClientId,
      galleryCoreTableName: existingTargets.galleryCoreTableName
    });
    return;
  }

  const galleryStack = new GalleryStack(app, galleryStackName, { env });

  new SyndicationSourceStack(app, syndicationStackName, {
    env,
    userPool: galleryStack.userPool,
    userPoolClient: galleryStack.userPoolClient,
    galleryCoreTable: galleryStack.galleryCoreTable
  });
};

void main();
