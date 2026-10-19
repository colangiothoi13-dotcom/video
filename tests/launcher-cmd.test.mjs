import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

async function launch(t,{installed=true,built=true,failStart=false}={}) {
 const directory=await mkdtemp(path.join(tmpdir(),'VietSub launcher '));t.after(()=>rm(directory,{recursive:true,force:true}));
 const script=path.join(directory,'Khoi-dong.cmd');await writeFile(script,await readFile(new URL('../Khoi-dong.cmd',import.meta.url)));
 if(installed){await mkdir(path.join(directory,'node_modules','next'),{recursive:true});await writeFile(path.join(directory,'node_modules','next','package.json'),'{}');}
 if(built){await mkdir(path.join(directory,'.next'));await writeFile(path.join(directory,'.next','BUILD_ID'),'fixture');}
 const stub=['@echo off','>> "%~dp0calls.txt" echo %*',...(failStart?['if "%1"=="start" exit /b 7']:[]),'exit /b 0',''].join('\r\n');await writeFile(path.join(directory,'npm.cmd'),stub);
 const result=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/c',script],{cwd:directory,env:{...process.env,PATH:directory+path.delimiter+process.env.PATH},input:'\r\n',encoding:'utf8',windowsHide:true,timeout:10000});
 const calls=await readFile(path.join(directory,'calls.txt'),'utf8').catch(()=> '');return {...result,calls:calls.trim().split(/\r?\n/).filter(Boolean)};
}

test('Windows double-click launcher reaches npm start without command parsing errors in a spaced path',{skip:process.platform!=='win32'},async t=>{
 const result=await launch(t);assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);assert.deepEqual(result.calls,['start']);assert.doesNotMatch(result.stdout+result.stderr,/not recognized|syntax.+incorrect/i);
});
test('Windows launcher installs and builds only when its required files are absent',{skip:process.platform!=='win32'},async t=>{
 const result=await launch(t,{installed:false,built:false});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);assert.deepEqual(result.calls,['install','run build','start']);
});
test('Windows launcher returns a failure when startup fails instead of reporting success',{skip:process.platform!=='win32'},async t=>{
 const result=await launch(t,{failStart:true});assert.ifError(result.error);assert.equal(result.status,1,result.stdout+result.stderr);assert.deepEqual(result.calls,['start']);
});
