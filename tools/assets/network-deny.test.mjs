import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  openSync,
  closeSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { buildNetworkDeny } from './build-network-deny.mjs';
const enabled = process.platform === 'linux' && process.arch === 'x64';
function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 32768,
    ...options,
  });
}

test(
  'required conversion boundary blocks network, remote-FD/process access, io_uring and namespace/process-group escapes',
  { skip: !enabled },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'cswatch-network-deny-'));
    try {
      const wrapper = buildNetworkDeny(join(root, 'network-deny')),
        source = join(root, 'probe.c'),
        binary = join(root, 'probe');
      writeFileSync(
        source,
        `#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <unistd.h>
static void denied(long result){if(result!=-1||errno!=EPERM){fprintf(stderr,"expected EPERM, result=%ld errno=%d\\n",result,errno);exit(8);}}
int main(int argc,char **argv){
 if(argc>1 && !strcmp(argv[1],"x32")){syscall(0x40000000L|SYS_getpid);return 77;}
 if(prctl(PR_GET_NO_NEW_PRIVS,0,0,0,0)!=1)return 9;
 denied(socket(AF_INET,SOCK_STREAM,0));denied(socket(AF_INET6,SOCK_DGRAM,0));denied(socket(AF_UNIX,SOCK_STREAM,0));
 int pair[2];denied(socketpair(AF_UNIX,SOCK_STREAM,0,pair));denied(syscall(SYS_connect,-1,NULL,0));
 denied(syscall(SYS_io_uring_setup,1,NULL));denied(syscall(SYS_process_vm_readv,getpid(),NULL,0,NULL,0,0));
 denied(syscall(SYS_pidfd_getfd,-1,0,0));denied(setsid());denied(setpgid(0,0));denied(unshare(CLONE_NEWNET));
 denied(prctl(PR_SET_PDEATHSIG,0,0,0,0));denied(fork());denied(syscall(SYS_clone,SIGCHLD,0,0,0,0));
 denied(syscall(SYS_mknodat,AT_FDCWD,"blocked-fifo",S_IFIFO|0600,0));denied(syscall(SYS_symlink,"target","link"));denied(syscall(SYS_link,"source","link"));
 errno=0;if(open("/proc/self/mem",O_RDWR)!=-1||errno!=EACCES)return 11;
 errno=0;if(fcntl(3,F_GETFD)!=-1||errno!=EBADF)return 10;
 puts("constrained");return 0;
}`,
      );
      const compiled = run('cc', [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        source,
        '-o',
        binary,
      ]);
      assert.equal(compiled.status, 0, compiled.stderr);
      const inherited = openSync(source, 'r');
      try {
        const checked = run(wrapper, ['--write-root', root, '--', binary], {
          stdio: ['ignore', 'pipe', 'pipe', inherited],
        });
        assert.equal(checked.status, 0, checked.stderr);
        assert.equal(checked.stdout.trim(), 'constrained');
        const alternate = run(wrapper, ['--write-root', root, '--', binary, 'x32']);
        assert.equal(alternate.signal, 'SIGSYS');
      } finally {
        closeSync(inherited);
      }
      assert.equal(run(wrapper, ['--write-root', root, '--', 'node', '--version']).status, 125);
      assert.equal(run(wrapper, ['--write-root', root, '--', '/missing/converter']).status, 125);
      const linked = join(root, 'linked');
      symlinkSync(root, linked);
      assert.equal(run(wrapper, ['--write-root', linked, '--', binary]).status, 125);
      const stdoutFile = join(root, 'outside-stdout'),
        stdoutFd = openSync(stdoutFile, 'w');
      try {
        assert.equal(
          run(wrapper, ['--write-root', root, '--', binary], {
            stdio: ['ignore', stdoutFd, 'pipe'],
          }).status,
          125,
        );
        assert.equal(readFileSync(stdoutFile).length, 0);
      } finally {
        closeSync(stdoutFd);
      }
      const writableInput = openSync(stdoutFile, 'r+');
      try {
        assert.equal(
          run(wrapper, ['--write-root', root, '--', binary], {
            stdio: [writableInput, 'pipe', 'pipe'],
          }).status,
          125,
        );
      } finally {
        closeSync(writableInput);
      }
      assert.throws(() => buildNetworkDeny(wrapper), /overwrite/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Node conversion keeps files, native image threads and inherited descendant denial functional',
  { skip: !enabled },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'cswatch-network-node-'));
    try {
      const wrapper = buildNetworkDeny(join(root, 'network-deny')),
        stage = join(root, 'stage'),
        home = join(root, 'home'),
        temporary = join(root, 'tmp'),
        output = join(stage, 'out.png');
      for (const path of [stage, home, temporary]) mkdirSync(path, { mode: 0o700 });
      const controls = ['tools', 'jobs', 'published', 'game'].map((name) => {
        const path = join(root, name);
        mkdirSync(path, { mode: 0o700 });
        const file = join(path, 'private-control');
        writeFileSync(file, 'untouched');
        return file;
      });
      const script = join(root, 'convert.mjs');
      const sharp = createRequire(import.meta.url).resolve('sharp');
      writeFileSync(
        script,
        `import{createRequire}from'node:module';import{writeFileSync,truncateSync,unlinkSync,renameSync,symlinkSync,linkSync}from'node:fs';import{spawnSync}from'node:child_process';import net from'node:net';
 const require=createRequire(import.meta.url),sharp=require(${JSON.stringify(sharp)});
 await sharp({create:{width:2,height:2,channels:4,background:{r:12,g:24,b:36,alpha:.5}}}).png().toFile(${JSON.stringify(output)});
 const child=spawnSync(process.execPath,['-e',"const n=require('node:net'),s=n.createServer();s.on('error',e=>process.exit(e.code==='EPERM'?0:2));s.listen(0,'127.0.0.1')"],{stdio:'inherit',timeout:5000});if(child.error?.code!=='EPERM')throw Error('Unexpected descendant process access: '+child.error?.code);
 const server=net.createServer();const denied=await new Promise(resolve=>{server.once('error',error=>resolve(error.code==='EPERM'));server.listen(0,'127.0.0.1',()=>{server.close();resolve(false);});});if(!denied)throw Error('Unexpected network');for(const file of ${JSON.stringify(controls)}){for(const change of [()=>writeFileSync(file,'changed'),()=>truncateSync(file,0),()=>unlinkSync(file),()=>renameSync(file,${JSON.stringify(join(stage, 'stolen'))})]){try{change();throw Error('Write escaped');}catch(error){if(!['EACCES','EXDEV'].includes(error.code))throw error;}}}for(const link of [()=>symlinkSync(${JSON.stringify(controls[0])},${JSON.stringify(join(stage, 'symlink'))}),()=>linkSync(${JSON.stringify(controls[0])},${JSON.stringify(join(stage, 'hardlink'))})]){try{link();throw Error('Link escaped');}catch(error){if(error.code!=='EPERM')throw error;}}writeFileSync(${JSON.stringify(join(stage, 'complete'))},'complete');`,
      );
      const result = run(
        wrapper,
        [
          '--write-root',
          stage,
          '--write-root',
          home,
          '--write-root',
          temporary,
          '--',
          process.execPath,
          script,
        ],
        { env: { ...process.env, HOME: home, TMPDIR: temporary } },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(stage, 'complete'), 'utf8'), 'complete');
      assert.equal(readFileSync(output).subarray(1, 4).toString(), 'PNG');
      for (const file of controls) assert.equal(readFileSync(file, 'utf8'), 'untouched');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'conversion boundary refuses inherited network standard IO before executing a command',
  { skip: !enabled },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'cswatch-network-stdio-')),
      server = createServer();
    try {
      const wrapper = buildNetworkDeny(join(root, 'network-deny'));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const fd = server._handle.fd;
      const result = run(
        wrapper,
        ['--write-root', root, '--', process.execPath, '-e', 'process.stdout.write("unexpected")'],
        {
          stdio: [fd, 'pipe', 'pipe'],
        },
      );
      assert.equal(result.status, 125);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /local standard IO required/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'immutable pack publication uses same-parent no-replace rename and rejects links, malformed names and existing targets',
  { skip: !enabled },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'cswatch-network-publish-'));
    try {
      const helper = buildNetworkDeny(join(root, 'network-deny')),
        id = 'a'.repeat(64),
        stage = join(root, `.preparing-${id}-Ab12cd`),
        target = join(root, id);
      mkdirSync(stage);
      writeFileSync(join(stage, 'pack.json'), 'original');
      assert.equal(run(helper, ['--publish', stage, target]).status, 0);
      assert.equal(existsSync(stage), false);
      assert.equal(readFileSync(join(target, 'pack.json'), 'utf8'), 'original');
      mkdirSync(stage);
      writeFileSync(join(stage, 'pack.json'), 'replacement');
      assert.equal(run(helper, ['--publish', stage, target]).status, 125);
      assert.equal(readFileSync(join(target, 'pack.json'), 'utf8'), 'original');
      assert.equal(readFileSync(join(stage, 'pack.json'), 'utf8'), 'replacement');
      const other = 'b'.repeat(64);
      assert.equal(run(helper, ['--publish', stage, join(root, other)]).status, 125);
      const linked = join(root, 'linked-parent');
      symlinkSync(root, linked);
      assert.equal(
        run(helper, ['--publish', join(linked, `.preparing-${id}-Ab12cd`), join(linked, id)])
          .status,
        125,
      );
      rmSync(stage, { recursive: true });
      symlinkSync(target, stage);
      assert.equal(run(helper, ['--publish', stage, join(root, id)]).status, 125);
      assert.equal(run(helper, ['--publish', target, join(root, other)]).status, 125);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'conversion cannot mutate shared metadata, signal or change limits of another process, or route signals through descriptors',
  { skip: !enabled },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'cswatch-network-metadata-'));
    let victim;
    try {
      const wrapper = buildNetworkDeny(join(root, 'network-deny')),
        stage = join(root, 'stage'),
        control = join(root, 'control'),
        source = join(root, 'metadata.c'),
        binary = join(root, 'metadata');
      mkdirSync(stage, { mode: 0o700 });
      writeFileSync(control, 'private unchanged', { mode: 0o640 });
      const metadata = ({ mode, uid, gid, atimeMs, mtimeMs }) => ({
        mode,
        uid,
        gid,
        atimeMs,
        mtimeMs,
      });
      const before = metadata(statSync(control));
      victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      await once(victim, 'spawn');
      const victimLimits = readFileSync('/proc/' + victim.pid + '/limits', 'utf8');
      writeFileSync(
        source,
        `#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/xattr.h>
#include <unistd.h>
#include <utime.h>
static void denied(const char *name,long result){if(result!=-1||errno!=EPERM){fprintf(stderr,"%s expected EPERM result=%ld errno=%d\\n",name,result,errno);exit(8);}}
int main(int argc,char **argv){
 if(argc!=4){return 2;}
 const char *path=argv[1];const int fd=open(path,O_RDONLY);if(fd<0)return 3;
 const int victim=atoi(argv[2]),self=getpid();struct timespec times[2]={{1,0},{1,0}};struct timeval tv[2]={{1,0},{1,0}};struct utimbuf old={1,1};
 denied("chmod",syscall(SYS_chmod,path,0));denied("fchmod",syscall(SYS_fchmod,fd,0));denied("fchmodat",syscall(SYS_fchmodat,AT_FDCWD,path,0));denied("fchmodat2",syscall(452,AT_FDCWD,path,0,0));
 denied("chown",syscall(SYS_chown,path,0,0));denied("lchown",syscall(SYS_lchown,path,0,0));denied("fchown",syscall(SYS_fchown,fd,0,0));denied("fchownat",syscall(SYS_fchownat,AT_FDCWD,path,0,0,0));
 denied("utime",syscall(SYS_utime,path,&old));denied("utimes",syscall(SYS_utimes,path,tv));denied("futimesat",syscall(SYS_futimesat,AT_FDCWD,path,tv));denied("utimensat",syscall(SYS_utimensat,fd,NULL,times,0));
 denied("setxattr",syscall(SYS_setxattr,path,"user.cswatch","x",1,0));denied("lsetxattr",syscall(SYS_lsetxattr,path,"user.cswatch","x",1,0));denied("fsetxattr",syscall(SYS_fsetxattr,fd,"user.cswatch","x",1,0));denied("setxattrat",syscall(463,AT_FDCWD,path,0,NULL,0));
 denied("removexattr",syscall(SYS_removexattr,path,"user.cswatch"));denied("lremovexattr",syscall(SYS_lremovexattr,path,"user.cswatch"));denied("fremovexattr",syscall(SYS_fremovexattr,fd,"user.cswatch"));denied("removexattrat",syscall(466,AT_FDCWD,path,0,"user.cswatch"));denied("file_setattr",syscall(469,AT_FDCWD,path,NULL,0));
 denied("kill victim",syscall(SYS_kill,victim,SIGSTOP));denied("kill process group",syscall(SYS_kill,0,SIGSTOP));denied("tgkill victim",syscall(SYS_tgkill,victim,victim,SIGSTOP));denied("tkill",syscall(SYS_tkill,self,0));
 denied("sigqueue victim",syscall(SYS_rt_sigqueueinfo,victim,SIGSTOP,NULL));denied("tgsigqueue victim",syscall(SYS_rt_tgsigqueueinfo,victim,victim,SIGSTOP,NULL));
 if(syscall(SYS_kill,self,0)||syscall(SYS_tgkill,self,self,0))return 4;
 struct rlimit limits;if(syscall(SYS_prlimit64,0,RLIMIT_NOFILE,NULL,&limits)||syscall(SYS_prlimit64,self,RLIMIT_NOFILE,NULL,&limits))return 5;limits.rlim_cur=0;denied("prlimit victim",syscall(SYS_prlimit64,victim,RLIMIT_NOFILE,&limits,NULL));
 denied("fcntl owner",fcntl(fd,F_SETOWN,victim));denied("fcntl ownerex",fcntl(fd,F_SETOWN_EX,NULL));denied("fcntl signal",fcntl(fd,F_SETSIG,SIGSTOP));denied("fcntl lease",fcntl(fd,F_SETLEASE,F_RDLCK));denied("fcntl notify",fcntl(fd,F_NOTIFY,DN_MODIFY));denied("fcntl async",fcntl(fd,F_SETFL,O_ASYNC));if(fcntl(fd,F_GETFL)<0||fcntl(fd,F_SETFL,O_NONBLOCK))return 6;
 long flags=0;denied("inode flag ioctl",ioctl(fd,FS_IOC_SETFLAGS,&flags));int pipefd[2],available=0;if(pipe(pipefd)||write(pipefd[1],"x",1)!=1||ioctl(pipefd[0],FIONREAD,&available)||available!=1)return 7;
 int nonblocking=1;if(ioctl(pipefd[0],FIONBIO,&nonblocking)||!(fcntl(pipefd[0],F_GETFL)&O_NONBLOCK))return 10;
 int output=open(argv[3],O_CREAT|O_WRONLY|O_EXCL,0600);if(output<0||write(output,"ok",2)!=2)return 9;
 close(output);close(fd);puts("metadata and process controls denied");return 0;
}`,
      );
      const compiled = run('cc', [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        source,
        '-o',
        binary,
      ]);
      assert.equal(compiled.status, 0, compiled.stderr);
      const result = run(wrapper, [
        '--write-root',
        stage,
        '--',
        binary,
        control,
        String(victim.pid),
        join(stage, 'complete'),
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'metadata and process controls denied');
      assert.deepEqual(metadata(statSync(control)), before);
      assert.equal(readFileSync('/proc/' + victim.pid + '/limits', 'utf8'), victimLimits);
      assert.doesNotMatch(
        readFileSync('/proc/' + victim.pid + '/status', 'utf8'),
        /^State:\s+[Tt]/m,
      );
      assert.equal(readFileSync(control, 'utf8'), 'private unchanged');
      assert.equal(readFileSync(join(stage, 'complete'), 'utf8'), 'ok');
    } finally {
      if (victim) {
        victim.kill('SIGKILL');
        await once(victim, 'exit');
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'native sound-bank publication is same-parent and no-replace even for empty targets or symlinks',
  { skip: !enabled },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'cswatch-sound-publish-'));
    try {
      const helper = buildNetworkDeny(join(root, 'boundary')),
        stage = join(root, '.sounds-Ab12cd'),
        target = join(root, 'sounds');
      mkdirSync(stage, { mode: 0o700 });
      writeFileSync(join(stage, 'proof'), 'original');
      assert.equal(run(helper, ['--publish-sounds', stage, target]).status, 0);
      assert.equal(readFileSync(join(target, 'proof'), 'utf8'), 'original');
      mkdirSync(stage, { mode: 0o700 });
      assert.equal(run(helper, ['--publish-sounds', stage, target]).status, 125);
      rmSync(target, { recursive: true });
      mkdirSync(target);
      assert.equal(run(helper, ['--publish-sounds', stage, target]).status, 125);
      rmSync(target, { recursive: true });
      symlinkSync(stage, target);
      assert.equal(run(helper, ['--publish-sounds', stage, target]).status, 125);
      assert.equal(run(helper, ['--publish-sounds', stage, join(root, 'other')]).status, 125);
      assert.equal(run(helper, ['--publish-sounds', root, target]).status, 125);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'native effect-texture publication is same-parent and no-replace even for empty targets or symlinks',
  { skip: !enabled },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'cswatch-effects-publish-'));
    try {
      const helper = buildNetworkDeny(join(root, 'boundary')),
        stage = join(root, '.effects-Ab12cd'),
        target = join(root, 'effects');
      mkdirSync(stage, { mode: 0o700 });
      writeFileSync(join(stage, 'proof'), 'original');
      assert.equal(run(helper, ['--publish-effects', stage, target]).status, 0);
      assert.equal(readFileSync(join(target, 'proof'), 'utf8'), 'original');
      mkdirSync(stage, { mode: 0o700 });
      assert.equal(run(helper, ['--publish-effects', stage, target]).status, 125);
      rmSync(target, { recursive: true });
      mkdirSync(target);
      assert.equal(run(helper, ['--publish-effects', stage, target]).status, 125);
      rmSync(target, { recursive: true });
      symlinkSync(stage, target);
      assert.equal(run(helper, ['--publish-effects', stage, target]).status, 125);
      assert.equal(run(helper, ['--publish-effects', stage, join(root, 'other')]).status, 125);
      assert.equal(run(helper, ['--publish-effects', root, target]).status, 125);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'preview publication uses only shared fixed map names and refuses any existing target',
  { skip: !enabled },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'cswatch-preview-publish-'));
    try {
      const helper = buildNetworkDeny(join(root, 'boundary')),
        registry = JSON.parse(
          readFileSync(new URL('../../shared/map-previews.json', import.meta.url), 'utf8'),
        );
      for (const name of registry.maps) {
        const stage = join(root, '.preview-Ab12cd'),
          target = join(root, name);
        mkdirSync(stage, { mode: 0o700 });
        writeFileSync(join(stage, 'original'), 'fixture');
        assert.equal(run(helper, ['--publish-preview', stage, target]).status, 0);
        mkdirSync(stage, { mode: 0o700 });
        assert.equal(run(helper, ['--publish-preview', stage, target]).status, 125);
        rmSync(stage, { recursive: true });
      }
      const stage = join(root, '.preview-Ef34gh');
      mkdirSync(stage, { mode: 0o700 });
      assert.equal(run(helper, ['--publish-preview', stage, join(root, 'de_unknown')]).status, 125);
      const empty = join(root, registry.maps[0]);
      rmSync(empty, { recursive: true });
      mkdirSync(empty);
      assert.equal(run(helper, ['--publish-preview', stage, empty]).status, 125);
      rmSync(empty, { recursive: true });
      symlinkSync(stage, empty);
      assert.equal(run(helper, ['--publish-preview', stage, empty]).status, 125);
      assert.equal(
        run(helper, ['--publish-preview', root, join(root, registry.maps[1])]).status,
        125,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
