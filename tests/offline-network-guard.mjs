// Test preloader: fail closed before any real network or child-process launch.
import http from 'node:http';import https from 'node:https';import net from 'node:net';import dgram from 'node:dgram';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
let attempts=0;
const forbidden=()=>{attempts++;throw new Error('offline_test_forbidden_io');};
http.request=forbidden;http.get=forbidden;https.request=forbidden;https.get=forbidden;
net.connect=forbidden;net.createConnection=forbidden;net.Socket.prototype.connect=forbidden;dgram.createSocket=forbidden;
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[k]=forbidden;
globalThis.fetch=forbidden;syncBuiltinESMExports();
process.on('exit',()=>{console.log(JSON.stringify({forbiddenIoAttempts:attempts}));if(attempts)process.exitCode=1;});
