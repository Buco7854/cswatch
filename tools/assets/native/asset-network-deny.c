/* Operator asset conversion boundary, separate from the demo parser sandbox.
 * Linux x86-64 only. The isolated asset worker supplies filesystem/container
 * policy; this inherited seccomp filter prevents conversion network access and
 * process/FD acquisition escapes while keeping ordinary native threads/IO.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <limits.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdint.h>
#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif
/* x86-64 syscall table. Keep modern metadata operations denied when building
 * against older libc headers as well as when running a newer host kernel. */
#ifndef __NR_fchmodat2
#define __NR_fchmodat2 452
#endif
#ifndef __NR_setxattrat
#define __NR_setxattrat 463
#endif
#ifndef __NR_removexattrat
#define __NR_removexattrat 466
#endif
#ifndef __NR_file_setattr
#define __NR_file_setattr 469
#endif
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE 1
#endif
#if !defined(__x86_64__)
#error The verified asset toolchain and this seccomp boundary require Linux x86-64.
#endif
#define DENY(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
#define OWN_PROCESS(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 4), \
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])), \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, converter_pid, 1, 0), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
static void fail(const char *message) {
    fprintf(stderr, "cswatch asset conversion boundary: %s (%s)\n", message, strerror(errno));
    _exit(125);
}
static void restrict_conversion(void) {
    const unsigned int converter_pid = (unsigned int)getpid();
    const struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        DENY(__NR_fork), DENY(__NR_vfork),
        DENY(__NR_link), DENY(__NR_linkat), DENY(__NR_symlink), DENY(__NR_symlinkat),
        DENY(__NR_mknod), DENY(__NR_mknodat),
        DENY(__NR_socket), DENY(__NR_socketpair), DENY(__NR_connect),
        DENY(__NR_bind), DENY(__NR_listen), DENY(__NR_accept), DENY(__NR_accept4),
        DENY(__NR_sendto), DENY(__NR_sendmsg), DENY(__NR_sendmmsg),
        DENY(__NR_recvfrom), DENY(__NR_recvmsg), DENY(__NR_recvmmsg),
        DENY(__NR_io_uring_setup), DENY(__NR_io_uring_enter), DENY(__NR_io_uring_register),
        DENY(__NR_ptrace), DENY(__NR_process_vm_readv), DENY(__NR_process_vm_writev),
        DENY(__NR_pidfd_getfd), DENY(__NR_pidfd_send_signal),
        DENY(__NR_tkill),
        OWN_PROCESS(__NR_kill), OWN_PROCESS(__NR_tgkill),
        OWN_PROCESS(__NR_rt_sigqueueinfo), OWN_PROCESS(__NR_rt_tgsigqueueinfo),
        /* The runtime may read/change its own limits, never the worker's. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prlimit64, 0, 5),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, converter_pid, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        /* Landlock does not mediate metadata mutation, even through read FDs. */
        DENY(__NR_chmod), DENY(__NR_fchmod), DENY(__NR_fchmodat), DENY(__NR_fchmodat2),
        DENY(__NR_chown), DENY(__NR_lchown), DENY(__NR_fchown), DENY(__NR_fchownat),
        DENY(__NR_utime), DENY(__NR_utimes), DENY(__NR_futimesat), DENY(__NR_utimensat),
        DENY(__NR_setxattr), DENY(__NR_lsetxattr), DENY(__NR_fsetxattr), DENY(__NR_setxattrat),
        DENY(__NR_removexattr), DENY(__NR_lremovexattr), DENY(__NR_fremovexattr), DENY(__NR_removexattrat),
        DENY(__NR_file_setattr),
        /* Terminal/pipe queries and libuv's fd-local O_NONBLOCK operation only.
         * Inode-flag/FS mutation ioctls cannot bypass the metadata policy. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_ioctl, 0, 7),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, TCGETS, 4, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, TIOCGWINSZ, 3, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, FIONREAD, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, FIONBIO, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        /* Leases, async owners and notifications can send signals indirectly. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_fcntl, 0, 16),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        DENY(F_SETOWN), DENY(F_SETOWN_EX), DENY(F_SETSIG),
        DENY(F_SETLEASE), DENY(F_NOTIFY),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETFL, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, O_ASYNC, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        DENY(__NR_setsid), DENY(__NR_setpgid), DENY(__NR_unshare), DENY(__NR_setns),
        DENY(__NR_mount), DENY(__NR_umount2), DENY(__NR_pivot_root),
        DENY(__NR_bpf), DENY(__NR_perf_event_open), DENY(__NR_userfaultfd),
        /* clone3's pointer flags cannot be safely inspected by classic BPF;
         * glibc falls back to clone for ordinary .NET/Node native threads. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 6),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K,
            CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC |
            CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        /* Conversion descendants cannot remove their worker-death binding. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prctl, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_SET_PDEATHSIG, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    const struct sock_fprog program = {
        .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
        .filter = (struct sock_filter *)filter,
    };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("no_new_privs required");
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) < 0) fail("seccomp required");
}
/* Handle every filesystem byte-write/create/remove/refer/truncate right.
 * Reads and execution remain governed by the isolated container/mounts. ABI 3
 * is essential: older kernels do not mediate truncate or cross-tree refer. */
enum { LL_WRITE = 1ULL << 1, LL_REMOVE_DIR = 1ULL << 4, LL_REMOVE = 1ULL << 5,
    LL_MAKE_CHAR = 1ULL << 6, LL_MAKE_DIR = 1ULL << 7, LL_MAKE_REG = 1ULL << 8,
    LL_MAKE_SOCK = 1ULL << 9, LL_MAKE_FIFO = 1ULL << 10, LL_MAKE_BLOCK = 1ULL << 11,
    LL_MAKE_SYM = 1ULL << 12, LL_REFER = 1ULL << 13, LL_TRUNCATE = 1ULL << 14 };
struct ruleset_attr { uint64_t fs; };
struct path_attr { uint64_t allowed; int32_t fd; } __attribute__((packed));
static int directory(const char *path) {
    if (!path || path[0] != '/' || strlen(path) >= PATH_MAX ||
        strstr(path,"//") || !path[1] || path[strlen(path)-1] == '/') {
        errno = EINVAL; fail("normalized private directory required");
    }
    char copy[PATH_MAX];
    strcpy(copy,path);
    int fd = open("/",O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if(fd < 0) fail("open root directory");
    char *save = NULL;
    for(char *part = strtok_r(copy,"/",&save);part;part = strtok_r(NULL,"/",&save)) {
        if(!strcmp(part,".") || !strcmp(part,"..")) { errno = EINVAL; fail("unsafe directory component"); }
        int next = openat(fd,part,O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if(next < 0) fail("open real private directory");
        close(fd); fd = next;
    }
    struct stat info;
    if(fstat(fd,&info) < 0) fail("stat private directory");
    if(!S_ISDIR(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 0022)) {
        errno = EACCES; fail("private directory ownership required");
    }
    return fd;
}
static void write_rule(int rules,int fd,uint64_t allowed) {
    const struct path_attr rule = {.allowed = allowed,.fd = fd};
    if(syscall(__NR_landlock_add_rule,rules,1,&rule,0) < 0) fail("add write confinement rule");
}
static int landlock_abi(void) {
    const int abi = syscall(__NR_landlock_create_ruleset,NULL,0,1);
    if(abi < 3) fail("Landlock ABI 3 or newer required");
    return abi;
}
static void restrict_writes(const char **roots,int count) {
    (void)landlock_abi();
    const uint64_t writes = LL_WRITE | LL_REMOVE_DIR | LL_REMOVE | LL_MAKE_CHAR |
        LL_MAKE_DIR | LL_MAKE_REG | LL_MAKE_SOCK | LL_MAKE_FIFO | LL_MAKE_BLOCK |
        LL_MAKE_SYM | LL_REFER | LL_TRUNCATE;
    const struct ruleset_attr attr = {.fs = writes};
    const int rules = syscall(__NR_landlock_create_ruleset,&attr,sizeof(attr),0);
    if(rules < 0) fail("create write confinement ruleset");
    const uint64_t allowed = LL_WRITE | LL_REMOVE_DIR | LL_REMOVE | LL_MAKE_DIR |
        LL_MAKE_REG | LL_REFER | LL_TRUNCATE;
    for(int i=0;i<count;i++) { int fd = directory(roots[i]); write_rule(rules,fd,allowed); close(fd); }
    int null_fd = open("/dev/null",O_PATH | O_CLOEXEC | O_NOFOLLOW);
    struct stat null_info;
    if(null_fd < 0 || fstat(null_fd,&null_info) < 0 || !S_ISCHR(null_info.st_mode)) fail("open null device");
    write_rule(rules,null_fd,LL_WRITE);close(null_fd);
    if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0) < 0 ||
        syscall(__NR_landlock_restrict_self,rules,0) < 0) fail("apply write confinement");
    close(rules);
}
static void standard_io(void) {
    /* Existing local Node stdio channels remain usable; no network FD may be
     * inherited as standard IO, and every other inherited FD is closed. */
    for(int fd=0;fd<3;fd++) {
        struct stat info;
        if(fstat(fd,&info) < 0) fail("standard IO required");
        if(S_ISREG(info.st_mode) && (fd != 0 || (fcntl(fd,F_GETFL) & O_ACCMODE) != O_RDONLY)) {
            errno=EINVAL;fail("output must be a local pipe, terminal or null device");
        }
        if(S_ISSOCK(info.st_mode)) {
            struct sockaddr_storage address;
            socklen_t size = sizeof(address);
            if(getsockname(fd,(struct sockaddr *)&address,&size) < 0 || address.ss_family != AF_UNIX) {
                errno = EINVAL;fail("local standard IO required");
            }
        }
    }
    if(syscall(__NR_close_range,3U,UINT_MAX,0U) < 0) fail("close inherited descriptors");
}
static int hex_id(const char *name) {
    if(strlen(name) != 64) return 0;
    for(int i=0;i<64;i++) if(!((name[i]>='0' && name[i]<='9') || (name[i]>='a' && name[i]<='f'))) return 0;
    return 1;
}
#ifndef CSWATCH_PREVIEW_NAMES
#error Build the asset boundary with the fixed shared preview registry.
#endif
static int preview_name(const char *name) {
    static const char *names[] = { CSWATCH_PREVIEW_NAMES };
    for(size_t i=0;i<sizeof(names)/sizeof(names[0]);i++) if(!strcmp(name,names[i])) return 1;
    return 0;
}
#ifndef CSWATCH_EQUIPMENT_NAMES
#error Build the asset boundary with the fixed shared equipment registry.
#endif
static int equipment_name(const char *name) {
    static const char *names[] = { CSWATCH_EQUIPMENT_NAMES };
    for(size_t i=0;i<sizeof(names)/sizeof(names[0]);i++) if(!strcmp(name,names[i])) return 1;
    return 0;
}
#ifndef CSWATCH_AGENT_NAMES
#error Build the asset boundary with the fixed shared agent catalogue.
#endif
static int agent_name(const char *name) {
    static const char *names[] = { CSWATCH_AGENT_NAMES };
    for(size_t i=0;i<sizeof(names)/sizeof(names[0]);i++) if(!strcmp(name,names[i])) return 1;
    return 0;
}
static void publish(const char *source,const char *target,int kind) {
    char from[PATH_MAX],to[PATH_MAX];
    if(!source || !target || strlen(source) >= sizeof(from) || strlen(target) >= sizeof(to)) {
        errno = EINVAL;fail("invalid publication paths");
    }
    strcpy(from,source);strcpy(to,target);
    char *from_name = strrchr(from,'/'),*to_name = strrchr(to,'/');
    if(!from_name || !to_name || from_name==from || to_name==to) { errno=EINVAL;fail("absolute same-parent publication required"); }
    *from_name++='\0';*to_name++='\0';
    int suffix_start=0;
    if(kind==1) {
        if(strcmp(from,to) || strcmp(to_name,"sounds") || strlen(from_name)!=14 || strncmp(from_name,".sounds-",8)) {
            errno=EINVAL;fail("approved same-parent sound bank names required");
        }
        suffix_start=8;
    } else if(kind==7) {
        if(strcmp(from,to) || strcmp(to_name,"effects") || strlen(from_name)!=15 || strncmp(from_name,".effects-",9)) {
            errno=EINVAL;fail("approved same-parent effect texture bank names required");
        }
        suffix_start=9;
    } else if(kind==2) {
        if(strcmp(from,to) || !preview_name(to_name) || strlen(from_name)!=15 || strncmp(from_name,".preview-",9)) {
            errno=EINVAL;fail("approved same-parent preview names required");
        }
        suffix_start=9;
    } else if(kind==3) {
        if(strcmp(from,to) || (strcmp(to_name,"agents") && strcmp(to_name,"equipment") && strcmp(to_name,"equipment-models") && strcmp(to_name,"viewmodels") && strcmp(to_name,"agent-models")) ||
            strlen(from_name)!=20 || strncmp(from_name,".presentation-",14)) {
            errno=EINVAL;fail("approved same-parent presentation bank names required");
        }
        suffix_start=14;
    } else if(kind==4) {
        if(strcmp(from,to) || (!equipment_name(to_name) && !agent_name(to_name)) || strlen(from_name)!=17 || strncmp(from_name,".equipment-",11)) {
            errno=EINVAL;fail("approved same-parent equipment model names required");
        }
        suffix_start=11;
    } else if(kind==6) {
        const size_t n=strlen(from_name);
        if(strcmp(from,to) || (!equipment_name(from_name) && !agent_name(from_name) && strcmp(from_name,"agents") && strcmp(from_name,"equipment")) ||
            strlen(to_name)!=10+n+24 || strncmp(to_name,".retired-",9) || strncmp(to_name+9,from_name,n) ||
            to_name[9+n]!='-') { errno=EINVAL;fail("approved same-parent presentation retirement required"); }
        for(size_t i=10+n;i<10+n+24;i++)
            if(!((to_name[i]>='0' && to_name[i]<='9') || (to_name[i]>='a' && to_name[i]<='f'))) {
                errno=EINVAL;fail("invalid private retirement identity");
            }
    } else if(kind==5) {
        if(strcmp(from,to) || !hex_id(from_name) || strlen(to_name)!=107 ||
            strncmp(to_name,".removing-",10) || strncmp(to_name+10,from_name,64) || to_name[74]!='-') {
            errno=EINVAL;fail("approved same-parent map retirement names required");
        }
        for(int i=75;i<107;i++) if(!((to_name[i]>='0' && to_name[i]<='9') ||
            (to_name[i]>='a' && to_name[i]<='f'))) {
            errno=EINVAL;fail("invalid private removal identity");
        }
    } else {
        if(strcmp(from,to) || !hex_id(to_name) || strlen(from_name)!=82 ||
            strncmp(from_name,".preparing-",11) || strncmp(from_name+11,to_name,64) || from_name[75]!='-') {
            errno=EINVAL;fail("approved same-parent pack names required");
        }
        suffix_start=76;
    }
    for(int i=suffix_start;kind!=5 && kind!=6 && i<suffix_start+6;i++) if(!((from_name[i]>='a' && from_name[i]<='z') ||
        (from_name[i]>='A' && from_name[i]<='Z') || (from_name[i]>='0' && from_name[i]<='9'))) {
        errno=EINVAL;fail("invalid private staging suffix");
    }
    const int parent = directory(from);
    const int stage = openat(parent,from_name,O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat before;
    if(stage < 0 || fstat(stage,&before) < 0 || before.st_uid != geteuid() || (before.st_mode & 0022))
        fail("real private staging directory required");
    restrict_conversion();
    if(syscall(__NR_renameat2,parent,from_name,parent,to_name,RENAME_NOREPLACE) < 0)
        fail("publish immutable pack without replacement");
    struct stat after;
    if(fstatat(parent,to_name,&after,AT_SYMLINK_NOFOLLOW) < 0 ||
        after.st_ino != before.st_ino || after.st_dev != before.st_dev || !S_ISDIR(after.st_mode))
        fail("publication directory identity changed");
    if(fsync(parent) < 0) fail("sync published pack parent");
    close(stage);close(parent);
}
int main(int argc,char **argv) {
    standard_io();
    if(argc == 4 && !strcmp(argv[1],"--publish")) { publish(argv[2],argv[3],0);return 0; }
    if(argc == 4 && !strcmp(argv[1],"--publish-sounds")) { publish(argv[2],argv[3],1);return 0; }
    if(argc == 4 && !strcmp(argv[1],"--publish-preview")) { publish(argv[2],argv[3],2);return 0; }
    if(argc == 4 && !strcmp(argv[1],"--publish-effects")) { publish(argv[2],argv[3],7);return 0; }
    if(argc == 4 && !strcmp(argv[1],"--publish-presentation")) { publish(argv[2],argv[3],3);return 0; }
    if(argc == 4 && !strcmp(argv[1],"--publish-equipment")) { publish(argv[2],argv[3],4);return 0; }
    if(argc == 4 && !strcmp(argv[1],"--retire-presentation")) { publish(argv[2],argv[3],6);return 0; }
    if(argc == 4 && !strcmp(argv[1],"--retire-map-pack")) { publish(argv[2],argv[3],5);return 0; }
    if(argc == 2 && !strcmp(argv[1],"--check")) {
        const int abi=landlock_abi();restrict_writes(NULL,0);restrict_conversion();
        printf("Linux x86-64 conversion confinement ready, Landlock ABI %d\n",abi);return 0;
    }
    const char *roots[8];int count=0,index=1;
    while(index+1<argc && !strcmp(argv[index],"--write-root")) {
        if(count==8) {errno=EINVAL;fail("too many private write roots");}
        roots[count++]=argv[index+1];index+=2;
    }
    if(!count || index+1>=argc || strcmp(argv[index],"--") || argv[index+1][0]!='/') {
        errno=EINVAL;fail("expected private write roots and absolute conversion executable");
    }
    index++;
    const pid_t parent=getppid();
    if(prctl(PR_SET_PDEATHSIG,SIGKILL) < 0) fail("bind conversion lifetime");
    if(getppid()!=parent) {errno=ESRCH;fail("worker parent changed");}
    struct rlimit cpu={450,450}, file={512UL*1024*1024,512UL*1024*1024};
    if(setrlimit(RLIMIT_CPU,&cpu)<0 || setrlimit(RLIMIT_FSIZE,&file)<0) fail("conversion limits");
    restrict_writes(roots,count);restrict_conversion();
    execv(argv[index],&argv[index]);fail("exec conversion");
}
