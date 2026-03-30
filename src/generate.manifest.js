#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env

// same of how you can easily generate complex manfiests.
// we actually use this for the support app

// remember to authorize the channels if needed; and remove private keys

// under development as tool to support os384 app development

import '../env.js'
import '../config.js'

// @deno-types="../dist/384.esm.d.ts"
import * as __ from "../dist/384.esm.js"

const SB = new __.ChannelApi(configuration.channelServer)
const mainBudgetChannel = await new __.Channel(configuration.budgetKey).ready

const appChannel = await SB.create(mainBudgetChannel)
const privateChannel = await SB.create(mainBudgetChannel)
const fsChannel = await SB.create(mainBudgetChannel)
const budgetChannel = await SB.create(mainBudgetChannel)

console.log(`
{
  "lang": "en",
  "short_name": "384 Support",
  "name": "384 Support App",
  "description": "Support for os384.",
  "version": "1.0.1",
  "author": "384, Inc.",
  "publisher": "PNk3X1P2803K9RK9q46iBGnpbRBeDAyMX5vcQh8tz0UpRHcGrko6M3bh6VlFtRuz6mKFs",
  "appid": "B3LHPRHuSLHjlYDExNEJzYeQNbnqhxNn_20240708_01",
  "vault": false,
  "mode": "production",
  "keywords": [
    "chat",
    "privacy",
    "web3",
    "384"
  ],
  "channels": [
    {
      "name": "ledger",
      "size": 4000000
    },
    {
      "name": "mainSupportAppChannel",
      "ownerPrivateKey": "${appChannel.userPrivateKey}",
      "handle": {
        "channelId": "${appChannel.channelData.channelId}",
        "channelData": {
          "channelId": "${appChannel.channelData.channelId}",
          "ownerPublicKey": "${appChannel.channelData.ownerPublicKey}"
        }
      }
    },
        {
      "name": "userProfileChannel",
      "ownerPrivateKey": "${privateChannel.userPrivateKey}",
        "handle": {
          "channelId": "${privateChannel.channelData.channelId}",
          "channelData": {
            "channelId": "${privateChannel.channelData.channelId}",
            "ownerPublicKey": "${privateChannel.channelData.ownerPublicKey}"
          }
        }
    },

    {
      "name": "documentsChannel",
        "ownerPrivateKey": "${fsChannel.userPrivateKey}",
        "handle": {
          "channelId": "${fsChannel.channelData.channelId}",
          "channelData": {
            "channelId": "${fsChannel.channelData.channelId}",
            "ownerPublicKey": "${fsChannel.channelData.ownerPublicKey}"
          }
        }
   },
    {
      "name": "supportAppBudgetChannel",
      "ownerPrivateKey": "${budgetChannel.userPrivateKey}",
        "handle": {
            "channelId": "${budgetChannel.channelData.channelId}",
            "channelData": {
            "channelId": "${budgetChannel.channelData.channelId}",
            "ownerPublicKey": "${budgetChannel.channelData.ownerPublicKey}"
        }
      }
    }
  ],
  "socialProof": [
    {
      "source": "384,inc",
      "website": "https://384.co",
      "twitter": "@384co",
      "github": "384co"
    }
  ],
  "channelServer": "https://c3.384.dev",
  "appServer": "https://384.dev"
}`);
