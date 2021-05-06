import debug from 'debug'
import { strict as assert } from 'assert'
import os from 'os'
import WorkerNodes from 'worker-nodes'
import { CreateSnapshotScriptOpts } from '../create-snapshot-script'
import {
  BundleAndProcessScriptResult,
  ProcessScriptOpts,
  ProcessScriptResult,
} from '../types'

const workerScript = require.resolve('./process-script.worker')

const logInfo = debug('snapgen:info')
const logTrace = debug('snapgen:trace')

type AsyncScriptProcessorOpts = {
  maxWorkers?: number
}

const DEFAULT_ASYNC_SCRIPT_PROCESSOR_OPTS = {
  maxWorkers: os.cpus().length,
}

export class AsyncScriptProcessor {
  private readonly _workers: WorkerNodesInstance
  private _isDisposed: boolean
  constructor(args: AsyncScriptProcessorOpts) {
    logInfo('Initializing async script processor')
    const processorOpts = Object.assign(
      {},
      DEFAULT_ASYNC_SCRIPT_PROCESSOR_OPTS,
      args
    )
    const { maxWorkers } = processorOpts
    const minWorkers = maxWorkers / 2

    const opts = {
      autoStart: true,
      lazyStart: false,
      minWorkers,
      maxWorkers,
      maxTasksPerWorker: 1,
      taskMaxRetries: 0,
    }
    this._isDisposed = false

    this._workers = new WorkerNodes(workerScript, opts)
  }

  createAndProcessScript(
    opts: CreateSnapshotScriptOpts,
    entryPoint: string
  ): Promise<BundleAndProcessScriptResult> {
    assert(!this._isDisposed, 'should not createAndProcessScript when disposed')

    return this._workers.call.createAndProcessScript(opts, entryPoint)
  }

  async processScript(opts: ProcessScriptOpts): Promise<ProcessScriptResult> {
    assert(!this._isDisposed, 'should not processScript when disposed')
    return this._workers.call.processScript(opts)
  }

  dispose() {
    logTrace('Disposing AsyncScriptProcessor')
    this._isDisposed = true
    return this._workers.terminate()
  }
}
