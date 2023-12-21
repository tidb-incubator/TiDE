import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as TOML from '@iarna/toml'

import { shell } from '../shell'
import { TiUP } from '../tiup'
import { Item } from './provider'

export class PlaygroundCommand {
  static async checkPlaygroundRun() {
    const res = await shell.exec('ps aux | grep tiup-playground | grep -v grep')
    const lines = res?.stdout.trim().split('\n').length
    return res?.code === 0 && lines === 1
  }

  static async displayPlayground() {
    const res = await shell.exec('tiup playground display')
    if (res?.code === 0) {
      // running
      const instances = {} as any
      const output = res.stdout
      const arr = output.split('\n')
      arr.forEach((line) => {
        const m = line.match(/(\d+)\s+(\w+)/)
        if (m) {
          const pid = m[1]
          const comp = m[2]
          instances[comp] = (instances[comp] || []).concat(pid)
        }
      })
      return instances
    }
    return undefined
  }

  static async startPlayground(
    tiup: TiUP,
    workspaceFolders: ReadonlyArray<vscode.WorkspaceFolder> | undefined,
    configPath?: string
  ) {
    const running = await PlaygroundCommand.checkPlaygroundRun()
    if (running) {
      vscode.window.showInformationMessage('TiUP Playground is running')
      vscode.commands.executeCommand('ticode.playground.refresh')
      return
    }

    if (configPath === undefined) {
      await tiup.invokeInSharedTerminal('playground')
      PlaygroundCommand.loopCheckPlayground()
      return
    }

    // read config
    const content = fs.readFileSync(configPath, { encoding: 'utf-8' })
    const obj = TOML.parse(content)
    // build command
    const folder = path.dirname(configPath)
    const args: string[] = []
    let preCmds: string[] = []
    Object.keys(obj).forEach((k) => {
      if (k !== 'tidb.version' && obj[k] !== '') {
        if (typeof obj[k] === 'boolean') {
          args.push(`--${k}=${obj[k]}`)
        } else if (
          k.endsWith('.config') &&
          (obj[k] as string).startsWith('components-config')
        ) {
          const fullPath = path.join(folder, obj[k] as string)
          args.push(`--${k} "${fullPath}"`)
        } else if (k.endsWith('.binpath') && (obj[k] as string) === 'current') {
          const pre = k.split('.')[0]
          let comp = pre
          // case by case
          if (pre === 'db') {
            comp = 'tidb'
          } else if (pre === 'kv') {
            comp = 'tikv'
          } else if (pre === 'pd') {
            comp = 'pd'
          }
          workspaceFolders?.forEach((folder) => {
            if (folder.name === comp) {
              if (comp === 'tidb') {
                preCmds.push(
                  `cd ${folder.uri.fsPath} && make && go build -gcflags='-N -l' -o ./bin/tidb-server ./cmd/tidb-server/main.go`
                )
                args.push(`--${k} ${folder.uri.fsPath}/bin/tidb-server`)
              } else if (comp === 'tikv') {
                preCmds.push(`cd ${folder.uri.fsPath} && make build`)
                args.push(
                  `--${k} ${folder.uri.fsPath}/target/debug/tikv-server`
                )
              } else if (comp === 'pd') {
                preCmds.push(
                  `cd ${folder.uri.fsPath} && make && go build -gcflags='-N -l' -o ./bin/pd-server cmd/pd-server/main.go`
                )
                args.push(`--${k} ${folder.uri.fsPath}/bin/pd-server`)
              }
            }
          })
        } else {
          args.push(`--${k} ${obj[k]}`)
        }
      }
    })
    const tidbVersion = obj['tidb.version'] || ''
    const cmd = `tiup playground ${tidbVersion} ${args.join(' ')}`
    let fullCmd = `${cmd} && exit`
    if (preCmds.length > 0) {
      preCmds.push('cd ~')
      fullCmd = `${preCmds.join(' && ')} && ${fullCmd}`
    }
    const t = await vscode.window.createTerminal('tiup playground')
    t.sendText(fullCmd)
    t.show()
    // await tiup.invokeInSharedTerminal(cmd)
    PlaygroundCommand.loopCheckPlayground()
  }

  static async reloadPlayground(
    tiup: TiUP,
    workspaceFolders: ReadonlyArray<vscode.WorkspaceFolder> | undefined,
    configPath?: string
  ) {
    await this.stopPlayground()
    await this.waitPlaygroundStop()
    await this.startPlayground(tiup, workspaceFolders, configPath)
  }

  static loopCheckPlayground(times: number = 30, intervals: number = 3 * 1000) {
    let tried = 0
    async function check() {
      const instances = await PlaygroundCommand.displayPlayground()
      if (instances) {
        vscode.commands.executeCommand('ticode.playground.refresh')
        return
      }
      tried++
      if (tried > times) {
        return
      }
      setTimeout(check, intervals)
    }
    setTimeout(check, intervals)
  }

  static viewInstanceLogs(pids: string[]) {
    pids.forEach(this.openInstanceLog)
  }

  static async openInstanceLog(pid: string) {
    const res = await shell.exec(`ps w -p ${pid} | grep tiup`)
    console.log('ps result:', res)
    const m = res?.stdout.match(/log-file=(.+)\.log/)
    if (m) {
      const logFilePath = m[1] + '.log'
      vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.file(logFilePath)
      )
    } else {
      vscode.window.showErrorMessage('open log file failed!')
      vscode.commands.executeCommand('ticode.playground.refresh')
    }
  }

  static followInstanceLogs(tiup: TiUP, pids: string[]) {
    pids.forEach((pid) => this.followInstanceLog(tiup, pid))
  }

  static async followInstanceLog(tiup: TiUP, pid: string) {
    const res = await shell.exec(`ps w -p ${pid} | grep tiup`)
    console.log('ps result:', res)
    const m = res?.stdout.match(/log-file=(.+)\.log/)
    if (m) {
      const logFilePath = m[1] + '.log'
      await tiup.invokeAnyInNewTerminal(`tail -f ${logFilePath}`, `log-${pid}`)
      return
    } else {
      vscode.window.showErrorMessage('open log file failed!')
      vscode.commands.executeCommand('ticode.playground.refresh')
    }
  }

  static debugCluster(tiup: TiUP, childs: Item[]) {
    childs.forEach((child) => {
      if (['pd', 'tikv', 'tidb'].indexOf(child.extra.comp) > -1) {
        this.debugInstance(tiup, child.extra.comp, child.extra.pids)
      }
    })
  }

  static debugInstances(tiup: TiUP, comp: string, pids: string[]) {
    pids.forEach((pid) => this.debugInstance(tiup, comp, pid))
  }

  static async debugInstance(tiup: TiUP, instanceName: string, pid: string) {
    if (['pd', 'tikv', 'tidb'].indexOf(instanceName) < 0) {
      vscode.window.showErrorMessage(
        `debug ${instanceName} is not supported yet `
      )
      return
    }
    const wd = (vscode.workspace.workspaceFolders || []).find(
      (folder) => folder.name === instanceName
    )
    if (!wd) {
      vscode.window.showErrorMessage(
        `${instanceName} is not included in workspace, please add it into workspace.`
      )
      return
    }
    switch (instanceName) {
      case 'tidb': {
        const debugConfiguration = {
          type: 'go',
          request: 'attach',
          name: 'Attach TiDB',
          mode: 'local',
          processId: Number(pid),
        }
        vscode.debug.startDebugging(wd, debugConfiguration)
        break
      }
      case 'pd': {
        const debugConfiguration = {
          type: 'go',
          request: 'attach',
          name: 'Attach PD',
          mode: 'local',
          processId: Number(pid),
        }
        vscode.debug.startDebugging(wd, debugConfiguration)
        break
      }
      case 'tikv': {
        const debugConfiguration = {
          type: 'lldb',
          request: 'attach',
          name: 'Attach TiKV',
          pid: Number(pid),
        }
        vscode.debug.startDebugging(wd, debugConfiguration)
        break
      }
    }
  }

  static async connectMySQL(tiup: TiUP) {
    const cmd = `mysql --host 127.0.0.1 --port 4000 -u root -p --comments`
    tiup.invokeAnyInNewTerminal(cmd, 'connect tidb')
  }

  static async tpccPrepare(tiup: TiUP) {
    const cmd = `tiup bench tpcc prepare --host 127.0.0.1 --port 4000 --user root`
    tiup.invokeAnyInNewTerminal(cmd, 'TPCC Prepare')
  }

  static async tpccRun(tiup: TiUP) {
    const cmd = `tiup bench tpcc run --host 127.0.0.1 --port 4000 --user root`
    tiup.invokeAnyInNewTerminal(cmd, 'TPCC Run')
  }

  static async tpccCleanUp(tiup: TiUP) {
    const cmd = `tiup bench tpcc cleanup --host 127.0.0.1 --port 4000 --user root`
    tiup.invokeAnyInNewTerminal(cmd, 'TPCC CleanUp')
  }

  static async tpccCheck(tiup: TiUP) {
    const cmd = `tiup bench tpcc check --host 127.0.0.1 --port 4000 --user root`
    tiup.invokeAnyInNewTerminal(cmd, 'TPCC Check')
  }

  static async stopPlayground() {
    // use "ps ax" instead of "ps aux" make the PID first column
    let cr = await shell.exec('ps ax | grep tiup-playground | grep -v grep')
    const lines = cr?.stdout.trim().split('\n')
    if (cr?.code === 0 && lines?.length === 1) {
      const pid = lines[0].split(/\s+/)[0]
      cr = await shell.exec(`kill ${pid}`)
      if (cr?.code === 0) {
        // loop check tiup-playground stop
        vscode.window.showInformationMessage('stopping playground...')
        this.loopCheckPlaygroundStop()
        return
      }
    }
    vscode.window.showErrorMessage('stop playground failed!')
    vscode.commands.executeCommand('ticode.playground.refresh')
  }

  static loopCheckPlaygroundStop(
    times: number = 10,
    intervals: number = 3 * 1000
  ) {
    let tried = 0
    async function check() {
      const running = await PlaygroundCommand.checkPlaygroundRun()
      if (!running) {
        vscode.commands.executeCommand('ticode.playground.refresh')
        return
      }
      tried++
      if (tried > times) {
        return
      }
      setTimeout(check, intervals)
    }
    setTimeout(check, intervals)
  }

  static async waitPlaygroundStop(
    times: number = 10,
    intervals: number = 3 * 1000
  ) {
    let tried = 0
    async function check() {
      const running = await PlaygroundCommand.checkPlaygroundRun()
      if (!running) {
        vscode.commands.executeCommand('ticode.playground.refresh')
        return
      }
      tried++
      if (tried > times) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, intervals))
      await check()
    }
    await check()
  }
}
