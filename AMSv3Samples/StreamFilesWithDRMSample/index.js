/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for
 * license information.
 */
'use strict';


const os = require("os");
const async = require('async');
const util = require('util');
const uuidv4 = require('uuid/v4');
const path = require('path');
const url = require('url');
const fs = require('fs');

const MediaServices = require('azure-arm-mediaservices');
const msRestAzure = require('ms-rest-azure');
const msRest = require('ms-rest');
const azureStorage = require('azure-storage');

const setTimeoutPromise = util.promisify(setTimeout);

// endpoint config
// make sure your URL values end with '/'

const armAadAudience = "https://management.core.windows.net/";
const aadEndpoint = "https://login.microsoftonline.com/";
const armEndpoint = "https://management.azure.com/";
const subscriptionId = "00000000-0000-0000-0000-000000000000";
const accountName ="amsaccount";
const region ="West US 2";
const aadClientId = "00000000-0000-0000-0000-000000000000";
const aadSecret ="00000000-0000-0000-0000-000000000000";
const aadTenantId ="00000000-0000-0000-0000-000000000000";
const resourceGroup ="amsResourceGroup";

// args
const outputFolder = "Temp";
const namePrefix = "prefix";

// You can either specify a local input file with the inputFile or an input Url with inputUrl.  Set the other one to null.

// const inputUrl = null;
// const inputFile = "c:\\temp\\input.mp4";

const inputFile = null;
const inputUrl = "https://amssamples.streaming.mediaservices.windows.net/2e91931e-0d29-482b-a42b-9aadc93eb825/AzurePromo.mp4";

const encodingTransformName = "TransformWithAdaptiveStreamingPreset";
const contentKeyPolicyName = "CommonEncryptionCencDrmContentKeyPolicy";

// constants
const timeoutSeconds = 60 * 10;
const sleepInterval = 1000 * 15;

let azureMediaServicesClient;
let inputExtension;
let blobName = null;

///////////////////////////////////////////
//     Entrypoint for sample script      //
///////////////////////////////////////////

msRestAzure.loginWithServicePrincipalSecret(aadClientId, aadSecret, aadTenantId, {
  environment: {
    activeDirectoryResourceId: armAadAudience,
    resourceManagerEndpointUrl: armEndpoint,
    activeDirectoryEndpointUrl: aadEndpoint
  }
}, async function (err, credentials, subscriptions) {
  if (err) return console.log(err);
  azureMediaServicesClient = new MediaServices(credentials, subscriptionId, armEndpoint, { noRetryPolicy: true });

  parseArguments();
  try {


    // Ensure that you have the desired encoding Transform. This is really a one time setup operation.
    console.log("creating encoding transform...");
    let adaptiveStreamingTransform = {
      odatatype: "#Microsoft.Media.BuiltInStandardEncoderPreset",
      presetName: "AdaptiveStreaming"
    };
    let encodingTransform = await ensureTransformExists(resourceGroup, accountName, encodingTransformName, adaptiveStreamingTransform);

    console.log("getting job input from arguments...");
    let uniqueness = uuidv4();
    let input = await getJobInputFromArguments(uniqueness);
    let outputAssetName = namePrefix + '-output-' + uniqueness;
    let jobName = namePrefix + '-job-' + uniqueness;
    let locatorName = "locator" + uniqueness;

    console.log("creating output asset...");
    let outputAsset = await createOutputAsset(resourceGroup, accountName, outputAssetName);

    console.log("submitting job...");
    let job = await submitJob(resourceGroup, accountName, encodingTransformName, jobName, input, outputAsset.name);

    console.log("waiting for job to finish...");
    job = await waitForJobToFinish(resourceGroup, accountName, encodingTransformName, jobName);

    if (job.state == "Finished") {
      await downloadResults(resourceGroup, accountName, outputAsset.name, outputFolder);

      await ensureContentKeyPolicyExists(resourceGroup, accountName, contentKeyPolicyName);

      let locator = await createStreamingLocator(resourceGroup, accountName, outputAsset.name, locatorName, contentKeyPolicyName);

      let urls = await getStreamingUrls(resourceGroup, accountName, locator.name);

      console.log("deleting jobs ...");
      await azureMediaServicesClient.jobs.deleteMethod(resourceGroup, accountName, encodingTransformName, jobName);
      // await azureMediaServicesClient.assets.deleteMethod(resourceGroup, accountName, outputAsset.name);

      let jobInputAsset = input;
      if (jobInputAsset && jobInputAsset.assetName) {
        await azureMediaServicesClient.assets.deleteMethod(resourceGroup, accountName, jobInputAsset.assetName);
      }
    } else if (job.state == "Error") {
      console.log(`${job.name} failed. Error details:`);
      console.log(job.outputs[0].error);
    } else if (job.state == "Canceled") {
      console.log(`${job.name} was unexpectedly canceled.`);
    } else {
      console.log(`${job.name} is still in progress.  Current state is ${job.state}.`);
    }
    console.log("done with sample");
  } catch (err) {
    console.log(err);
  }
});

async function downloadResults(resourceGroup, accountName, assetName, resultsFolder) {
  let date = new Date();
  date.setHours(date.getHours() + 1);
  let input = {
    permissions: "Read",
    expiryTime: date
  }
  let assetContainerSas = await azureMediaServicesClient.assets.listContainerSas(resourceGroup, accountName, assetName, input);

  let containerSasUrl = assetContainerSas.assetContainerSasUrls[0] || null;
  let sasUri = url.parse(containerSasUrl);
  let sharedBlobService = azureStorage.createBlobServiceWithSas(sasUri.host, sasUri.search);
  let containerName = sasUri.pathname.replace(/^\/+/g, '');
  let directory = path.join(resultsFolder, assetName);
  try {
    fs.mkdirSync(directory);
  } catch (err) {
    // directory exists
  }
  console.log(`gathering blobs in container ${containerName}...`);
  function createBlobListPromise() {
    return new Promise(function (resolve, reject) {
      return sharedBlobService.listBlobsSegmented(containerName, null, (err, result, response) => {
        if (err) { reject(err); }
        resolve(result);
      });
    });
  }
  let blobs = await createBlobListPromise();
  console.log("downloading blobs to local directory in background...");
  for (let i = 0; i < blobs.entries.length; i++) {
    let blob = blobs.entries[i];
    if (blob.blobType == "BlockBlob") {
      sharedBlobService.getBlobToLocalFile(containerName, blob.name, path.join(directory, blob.name), (error, result) => {
        if (error) console.log(error);
      });
    }
  }
}

async function waitForJobToFinish(resourceGroup, accountName, transformName, jobName) {
  let timeout = new Date();
  timeout.setSeconds(timeout.getSeconds() + timeoutSeconds);

  async function pollForJobStatus() {
    let job = await azureMediaServicesClient.jobs.get(resourceGroup, accountName, transformName, jobName);
    console.log(job.state);
    if (job.state == 'Finished' || job.state == 'Error' || job.state == 'Canceled') {
      return job;
    } else if (new Date() > timeout) {
      console.log(`Job ${job.name} timed out.`);
      return job;
    } else {
      await setTimeoutPromise(sleepInterval, null);
      return pollForJobStatus();
    }
  }

  return await pollForJobStatus();
}

async function submitJob(resourceGroup, accountName, transformName, jobName, jobInput, outputAssetName) {
  let jobOutputs = [
    {
      odatatype: "#Microsoft.Media.JobOutputAsset",
      assetName: outputAssetName
    }
  ];

  return await azureMediaServicesClient.jobs.create(resourceGroup, accountName, transformName, jobName, {
    input: jobInput,
    outputs: jobOutputs
  });
}


async function getJobInputFromArguments(resourceGroup, accountName, uniqueness) {
  if (inputFile) {
    let assetName = namePrefix + "-input-" + uniqueness;
    await createInputAsset(resourceGroup, accountName, assetName, inputFile);
    return {
      odatatype: "#Microsoft.Media.JobInputAsset",
      assetName: assetName
    }
  } else {
    return {
      odatatype: "#Microsoft.Media.JobInputHttp",
      files: [inputUrl]
    }
  }
}

async function createOutputAsset(resourceGroup, accountName, assetName) {
  return await azureMediaServicesClient.assets.createOrUpdate(resourceGroup, accountName, assetName, {});
}

async function createInputAsset(resourceGroup, accountName, assetName, fileToUpload) {
  let asset = await azureMediaServicesClient.assets.createOrUpdate(resourceGroup, accountName, assetName, {});
  let date = new Date();
  date.setHours(date.getHours() + 1);
  let input = {
    permissions: "ReadWrite",
    expiryTime: date
  }
  let response = await azureMediaServicesClient.assets.listContainerSas(resourceGroup, accountName, assetName, input);
  let uploadSasUrl = response.assetContainerSasUrls[0] || null;
  let fileName = path.basename(fileToUpload);
  let sasUri = url.parse(uploadSasUrl);
  let sharedBlobService = azureStorage.createBlobServiceWithSas(sasUri.host, sasUri.search);
  let containerName = sasUri.pathname.replace(/^\/+/g, '');
  let randomInt = Math.round(Math.random() * 100);
  blobName = fileName + randomInt;
  console.log("uploading to blob...");
  function createBlobPromise() {
    return new Promise(function (resolve, reject) {
      sharedBlobService.createBlockBlobFromLocalFile(containerName, blobName, fileToUpload, resolve);
    });
  }
  await createBlobPromise();
  return asset;
}

async function ensureTransformExists(resourceGroup, accountName, transformName, preset) {
  let transform = await azureMediaServicesClient.transforms.get(resourceGroup, accountName, transformName);
  if (!transform) {
    transform = await azureMediaServicesClient.transforms.createOrUpdate(resourceGroup, accountName, transformName, {
      name: transformName,
      location: region,
      outputs: [{
        preset: preset
      }]
    });
  }
  return transform;
}

async function ensureContentKeyPolicyExists(resourceGroup, accountName, policyName) {
  let contentKeyPolicy = await azureMediaServicesClient.contentKeyPolicies.get(resourceGroup, accountName, policyName);
  if (!contentKeyPolicy) {
    contentKeyPolicy = await azureMediaServicesClient.contentKeyPolicies.createOrUpdate(resourceGroup, accountName, policyName, {
      description: "Content Key Policy Description",
      options: [
        {
          "name": "CommonEncryptionWidevineOpenOption",
          "configuration": {
            "odatatype": "#Microsoft.Media.ContentKeyPolicyWidevineConfiguration",
            "widevineTemplate": "{}"
          },
          "restriction": {
            "odatatype": "#Microsoft.Media.ContentKeyPolicyOpenRestriction"
          }
        },
        {
          "name": "CommonEncryptionPlayReadyOpenOption",
          "configuration": {
            "licenses": [
              {
                "allowTestDevices": false,
                "playRight": {
                  "digitalVideoOnlyContentRestriction": false,
                  "imageConstraintForAnalogComponentVideoRestriction": false,
                  "imageConstraintForAnalogComputerMonitorRestriction": false,
                  "allowPassingVideoContentToUnknownOutput": "NotAllowed"
                },
                "licenseType": "NonPersistent",
                "contentKeyLocation": {
                  "odatatype": "#Microsoft.Media.ContentKeyPolicyPlayReadyContentEncryptionKeyFromHeader"
                },
                "contentType": "UltraVioletStreaming"
              }
            ],
            "odatatype": "#Microsoft.Media.ContentKeyPolicyPlayReadyConfiguration",
            "responseCustomData": null
          },
          "restriction": {
            "odatatype": "#Microsoft.Media.ContentKeyPolicyOpenRestriction"
          }
        }
      ]
    });
  }
}

async function createStreamingLocator(resourceGroup, accountName, assetName, locatorName, contentKeyPolicyName) {
  let streamingLocator = {
    assetName: assetName,
    streamingPolicyName: "Predefined_MultiDrmCencStreaming",
    defaultContentKeyPolicyName: contentKeyPolicyName
  };

  let locator = await azureMediaServicesClient.streamingLocators.create(
    resourceGroup,
    accountName,
    locatorName,
    streamingLocator);

  return locator;
}

async function getStreamingUrls(resourceGroup, accountName, locatorName) {
  // Make sure the streaming endpoint is in the "Running" state.

  let streamingEndpoint = await azureMediaServicesClient.streamingEndpoints.get(resourceGroup, accountName, "default");

  let paths = await azureMediaServicesClient.streamingLocators.listPaths(resourceGroup, accountName, locatorName);

  for (let i = 0; i < paths.streamingPaths.length; i++) {
    let path = paths.streamingPaths[i].paths[0];
    console.log("https://" + streamingEndpoint.hostName + "//" + path);
  }
}

function parseArguments() {
  if (inputFile) {
    inputExtension = path.extname(inputFile);
  } else {
    inputExtension = path.extname(inputUrl);
  }
}
