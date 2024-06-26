// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../node_modules/aws-cdk-lib/custom-resources/lib/provider-framework/types.d.ts" />

// Cheating a bit as it seems the type is not available in the export.
// TODO: Duplicate the relevant type parts?
import Zip from "adm-zip"
import {
  LambdaClient,
  GetFunctionCommand,
  UpdateFunctionCodeCommand,
  GetFunctionCommandOutput,
} from "@aws-sdk/client-lambda"
import axios from "axios"
import { mkdtempSync, writeFileSync } from "fs"
import { resolve } from "path"
import { acquireLock, releaseLock } from "./locks"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Config = Record<string, any>

const RETRY_INTERVAL_MS = 15000
const RETRY_ATTEMPTS = 6

export const handler: AWSCDKAsyncCustomResource.OnEventHandler = async (
  event: AWSCDKAsyncCustomResource.OnEventRequest,
) => {
  switch (event.RequestType) {
    case "Delete":
      // Nothing to do on delete.
      return {
        PhysicalResourceId: event.PhysicalResourceId,
      }

    case "Create":
    case "Update":
      console.log(JSON.stringify(event))

      const functionArnFull = event.ResourceProperties.FunctionArn as string
      const config = event.ResourceProperties.Config as Config
      const lockTableName = getTableNameFromArn(config["locksTable"] as string)
      const functionArn = withoutVersion(functionArnFull)

      const lambda = new LambdaClient({
        region: getFunctionRegion(functionArn),
      })

      return createOrUpdateFunction(lambda, functionArn, config, lockTableName)
  }
}

const getTableNameFromArn = (arn: string): string | undefined => {
  const match = arn.match(/table\/([^/]+)/)
  return match ? match[1] : undefined
}

const createOrUpdateFunction = async (
  lambda: LambdaClient,
  functionSimpleArn: string,
  config: Config,
  lockTableName?: string,
) => {
  const lockName = `${functionSimpleArn}-update-lock`
  if (lockTableName) {
    let acquireLockResult: boolean | null = null
    let retryCount = 0
    while (acquireLockResult === null || !acquireLockResult) {
      acquireLockResult = await acquireLock(lockTableName, lockName)
      if (!acquireLockResult) {
        retryCount++
        if (retryCount === RETRY_ATTEMPTS) {
          console.log(
            `Could not acquire lock to update function '${functionSimpleArn}' after ${retryCount} retries. Preparing to exit.`,
          )
          throw new Error(
            `Could not acquire lock to update function '${functionSimpleArn}`,
          )
        } else {
          console.log(
            `Could not acquire lock to update function '${functionSimpleArn}'. Retrying in ${
              RETRY_INTERVAL_MS / 1000
            } seconds...`,
          )
          await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS))
        }
      }
    }
  }

  try {
    const { Code } = await waitAndGetFunction(functionSimpleArn)

    const { data } = await axios.get<Buffer>(Code!.Location!, {
      responseType: "arraybuffer",
    })

    const { CodeSha256, Version, FunctionArn } = await lambda.send(
      new UpdateFunctionCodeCommand({
        FunctionName: functionSimpleArn,
        ZipFile: addConfigToZip(data, config),
        Publish: true,
      }),
    )

    if (FunctionArn) {
      await waitAndGetFunction(FunctionArn) // Wait for the new function version to be ready
    }
    console.log(`Updated function '${functionSimpleArn}'`, {
      CodeSha256,
      Version,
    })
    return {
      PhysicalResourceId: functionSimpleArn,
      Data: { CodeSha256, Version, FunctionArn },
    }
  } catch (err) {
    console.error(`Error updating function '${functionSimpleArn}':`, err)
    throw err
  } finally {
    if (lockTableName) {
      await releaseLock(lockTableName, lockName)
    }
  }
}

function getFunctionRegion(arn: string): string {
  const match = /^arn:aws:lambda:([^:]+):/.exec(arn)
  if (!match) {
    throw new Error(`Could not extract region from '${arn}'`)
  }
  return match[1]
}

function withoutVersion(arn: string): string {
  // Example value: arn:aws:lambda:eu-west-1:112233445566:function:my-function:1
  // Result: arn:aws:lambda:eu-west-1:112233445566:function:my-function
  const match = /^(arn:aws:lambda:[^:]+:[^:]+:function:[^:]+):[^:]+$/.exec(arn)
  if (!match) {
    return arn
  }
  return match[1]
}

async function waitAndGetFunction(
  functionArn: string,
  timeoutMs = 30000,
): Promise<GetFunctionCommandOutput> {
  const lambda = new LambdaClient({ region: getFunctionRegion(functionArn) })

  const startTime = Date.now()
  let timeout = false

  while (!timeout) {
    const response = await lambda.send(
      new GetFunctionCommand({ FunctionName: functionArn }),
    )
    console.log(JSON.stringify(response, null, 2))

    if (
      response.Configuration?.State === "Active" &&
      response.Configuration?.LastUpdateStatus === "Successful"
    ) {
      console.log(`Function update ready: ${functionArn}`)
      return response
    }

    if (Date.now() - startTime >= timeoutMs) {
      timeout = true
      break
    }
    console.log(`Waiting for function update ready: ${functionArn}`)
    await new Promise((resolve) => setTimeout(resolve, 1000)) // Wait 1 second before trying again
  }

  throw new Error(`Timeout waiting for function update ready: ${functionArn}`)
}

function addConfigToZip(data: Buffer, config: Config): Buffer {
  const lambdaZip = new Zip(data)
  const tempDir = mkdtempSync("/tmp/lambda-package")
  lambdaZip.extractAllTo(tempDir, true)
  writeFileSync(
    resolve(tempDir, "config.json"),
    Buffer.from(JSON.stringify(config, null, 2)),
  )

  const newLambdaZip = new Zip()
  newLambdaZip.addLocalFolder(tempDir)
  return newLambdaZip.toBuffer()
}
