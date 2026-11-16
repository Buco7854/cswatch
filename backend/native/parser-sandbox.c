/*
 * Linux kernel boundary for the disposable native parser, not an application server.
 * Requires Landlock ABI 3 (Linux 6.2+) and seccomp; every failure is fail-closed.
 * Landlock is inherited by descendants and also confines native addon syscalls.
 * Reference: https://docs.kernel.org/userspace-api/landlock.html
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif
#ifndef __NR_fchmodat2
#define __NR_fchmodat2 452
#endif

enum {
    LL_EXECUTE = 1ULL << 0, LL_WRITE = 1ULL << 1,
    LL_READ = 1ULL << 2, LL_READ_DIR = 1ULL << 3,
    LL_REMOVE_DIR = 1ULL << 4, LL_REMOVE = 1ULL << 5,
    LL_MAKE_DIR = 1ULL << 7, LL_MAKE_REG = 1ULL << 8,
    LL_TRUNCATE = 1ULL << 14,
};
struct ruleset_attr { uint64_t fs, net, scoped; };
struct path_attr { uint64_t allowed; int32_t fd; } __attribute__((packed));

static void die(const char *message) {
    fprintf(stderr, "cswatch parser sandbox: %s (%s)\n", message, strerror(errno));
    _exit(125);
}
static void allow_path(int rules, const char *path, uint64_t access, int optional) {
    const int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) { if (optional && errno == ENOENT) return; die("open allowed path"); }
    struct stat info;
    if (fstat(fd, &info) < 0) die("stat allowed path");
    if (!S_ISDIR(info.st_mode)) access &= LL_EXECUTE | LL_READ | LL_WRITE | LL_TRUNCATE;
    const struct path_attr rule = { .allowed = access, .fd = fd };
    if (syscall(__NR_landlock_add_rule, rules, 1, &rule, 0) < 0) die("add filesystem rule");
    close(fd);
}

#define DENY(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static void restrict_syscalls(void) {
    const struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
#if defined(__x86_64__)
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
#elif defined(__aarch64__)
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0),
#else
#error Unsupported sandbox architecture; add and test the native seccomp ABI first.
#endif
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        /* Block x32 so alternate syscall numbers cannot evade the filter. */
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
        DENY(__NR_socket), DENY(__NR_socketpair), DENY(__NR_connect),
        DENY(__NR_bind), DENY(__NR_listen), DENY(__NR_accept),
        /* Landlock ABI 3 does not mediate filesystem/device ioctl operations. */
        DENY(__NR_ioctl),
        DENY(__NR_accept4), DENY(__NR_sendto), DENY(__NR_sendmsg),
        DENY(__NR_ptrace), DENY(__NR_process_vm_readv), DENY(__NR_process_vm_writev),
        DENY(__NR_kill), DENY(__NR_tkill), DENY(__NR_tgkill),
        DENY(__NR_rt_sigqueueinfo), DENY(__NR_rt_tgsigqueueinfo),
        DENY(__NR_setsid), DENY(__NR_setpgid), DENY(__NR_unshare), DENY(__NR_setns),
        DENY(__NR_mount), DENY(__NR_umount2), DENY(__NR_pivot_root),
        DENY(__NR_bpf), DENY(__NR_perf_event_open), DENY(__NR_userfaultfd),
        DENY(__NR_io_uring_setup), DENY(__NR_io_uring_enter), DENY(__NR_io_uring_register),
        DENY(__NR_pidfd_getfd), DENY(__NR_pidfd_send_signal),
        DENY(__NR_add_key), DENY(__NR_request_key), DENY(__NR_keyctl),
        /* Landlock does not mediate permission/timestamp/xattr changes yet. */
        DENY(__NR_fchmod), DENY(__NR_fchmodat), DENY(__NR_fchown), DENY(__NR_fchownat),
        DENY(__NR_utimensat), DENY(__NR_setxattr), DENY(__NR_lsetxattr), DENY(__NR_fsetxattr),
        DENY(__NR_removexattr), DENY(__NR_lremovexattr), DENY(__NR_fremovexattr),
        DENY(__NR_setrlimit),
        DENY(__NR_setuid), DENY(__NR_setgid), DENY(__NR_setreuid), DENY(__NR_setregid),
        DENY(__NR_setresuid), DENY(__NR_setresgid), DENY(__NR_setfsuid), DENY(__NR_setfsgid),
        DENY(__NR_setgroups), DENY(__NR_capset),
        DENY(__NR_sched_setaffinity), DENY(__NR_sched_setscheduler), DENY(__NR_sched_setparam),
        DENY(__NR_sched_setattr), DENY(__NR_setpriority), DENY(__NR_ioprio_set),
        DENY(__NR_shmget), DENY(__NR_shmat), DENY(__NR_shmdt), DENY(__NR_shmctl),
        DENY(__NR_semget), DENY(__NR_semop), DENY(__NR_semtimedop), DENY(__NR_semctl),
        DENY(__NR_msgget), DENY(__NR_msgsnd), DENY(__NR_msgrcv), DENY(__NR_msgctl),
#ifdef __NR_chmod
        DENY(__NR_chmod), DENY(__NR_chown), DENY(__NR_lchown),
        DENY(__NR_utime), DENY(__NR_utimes), DENY(__NR_futimesat),
#endif
#ifdef __NR_fchmodat2
        DENY(__NR_fchmodat2),
#endif
        /* Pipes are needed by Node. Do not let fasync ownership route signals to
         * an unsandboxed process, or place leases/notifications on runtime files. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_fcntl, 0, 16),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        DENY(F_SETOWN), DENY(F_SETOWN_EX), DENY(F_SETSIG),
        DENY(F_SETLEASE), DENY(F_NOTIFY),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETFL, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, O_ASYNC, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        /* Resource reads are needed by Node; changing any process limit is denied. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prlimit64, 0, 6),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 2),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2]) + 4),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prctl, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_SET_PDEATHSIG, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
#ifdef __NR_fork
        DENY(__NR_fork),
#endif
#ifdef __NR_vfork
        DENY(__NR_vfork),
#endif
        /* glibc falls back to clone() for threads when clone3 is unavailable. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x00010000 /* CLONE_THREAD */, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    const struct sock_fprog program = {
        .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
        .filter = (struct sock_filter *)filter,
    };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) < 0) die("install seccomp filter");
}

static unsigned long number(const char *value) {
    char *end;
    errno = 0;
    const unsigned long n = strtoul(value, &end, 10);
    if (errno || *end || n < 1 || n > 1048576) { errno = EINVAL; die("invalid limit"); }
    return n;
}

static pid_t worker_parent(void) {
    const char *value = getenv("CSWATCH_PARENT_PID");
    if (!value || !*value) { errno = EINVAL; die("missing expected worker parent"); }
    char *end;
    errno = 0;
    const long expected = strtol(value, &end, 10);
    if (errno || *end || expected < 1 || expected > INT_MAX) { errno = EINVAL; die("invalid expected worker parent"); }
    return (pid_t)expected;
}

int main(int argc, char **argv) {
    const int abi = syscall(__NR_landlock_create_ruleset, NULL, 0, 1);
    if (argc == 2 && strcmp(argv[1], "--check") == 0) {
        if (abi < 3) die("Landlock ABI 3 or newer required");
        printf("Landlock ABI %d\n", abi);
        return 0;
    }
    if (argc != 8 && argc != 10) { errno = EINVAL; die("expected job, code, dependencies, node, heap MB, file MB, timeout seconds, optional entry/model"); }
    if (abi < 3) die("Landlock ABI 3 or newer required");
    char *job = realpath(argv[1], NULL), *code = realpath(argv[2], NULL),
         *deps = realpath(argv[3], NULL), *node = realpath(argv[4], NULL);
    if (!job || !code || !deps || !node) die("resolve runtime paths");
    const char *entry = argc == 10 ? argv[8] : "parser.js";
    if (strcmp(entry, "parser.js") && strcmp(entry, "transcription-job.js")) { errno = EINVAL; die("invalid job entry"); }
    char *model = argc == 10 ? realpath(argv[9], NULL) : NULL;
    if (argc == 10 && !model) die("resolve readonly model");
    const unsigned long heap = number(argv[5]), expanded = number(argv[6]), timeout = number(argv[7]);
    const struct rlimit cores = {0, 0}, files = {128, 128},
        file_size = {(rlim_t)expanded * 1024 * 1024, (rlim_t)expanded * 1024 * 1024},
        cpu = {timeout, timeout + 1};
    if (setrlimit(RLIMIT_CORE, &cores) || setrlimit(RLIMIT_NOFILE, &files) ||
        setrlimit(RLIMIT_FSIZE, &file_size) || setrlimit(RLIMIT_CPU, &cpu)) die("set resource limit");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) die("set no_new_privs");
    /* PID 1 is the normal worker parent inside Docker. Compare the explicit
     * spawning parent's PID before/after prctl, rather than treating 1 as orphaned. */
    const pid_t expected_parent = worker_parent();
    if (getppid() != expected_parent) { errno = ESRCH; die("worker parent changed"); }
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0) die("bind parser lifetime to worker");
    if (getppid() != expected_parent) { errno = ESRCH; die("worker parent changed"); }
    /* ABI 3 handles truncate and cross-directory links; everything not granted is denied. */
    const struct ruleset_attr attr = { .fs = (1ULL << 15) - 1, .net = 0,
        .scoped = abi >= 6 ? 3 : 0 };
    const size_t attr_size = abi >= 6 ? sizeof(attr) : abi >= 4 ? 16 : 8;
    const int rules = syscall(__NR_landlock_create_ruleset, &attr, attr_size, 0);
    if (rules < 0) die("create filesystem ruleset");
    const uint64_t read_exec = LL_EXECUTE | LL_READ | LL_READ_DIR;
    allow_path(rules, code, read_exec, 0);
    allow_path(rules, deps, read_exec, 0);
    if (model) allow_path(rules, model, LL_READ | LL_READ_DIR, 0);
    char package_path[4096];
    if (snprintf(package_path, sizeof(package_path), "%s/../package.json", code) >= (int)sizeof(package_path)) die("package path too long");
    allow_path(rules, package_path, LL_READ, 0);
    allow_path(rules, node, LL_EXECUTE | LL_READ, 0);
    allow_path(rules, "/lib", read_exec, 1);
    allow_path(rules, "/lib64", read_exec, 1);
    allow_path(rules, "/usr/lib", read_exec, 1);
    allow_path(rules, "/etc/ld.so.cache", LL_READ, 1);
    allow_path(rules, "/etc/localtime", LL_READ, 1);
    allow_path(rules, "/usr/share/zoneinfo", LL_READ | LL_READ_DIR, 1);
    allow_path(rules, "/dev/null", LL_READ | LL_WRITE, 0);
    allow_path(rules, "/dev/urandom", LL_READ, 1);
    allow_path(rules, job, LL_READ | LL_READ_DIR | LL_WRITE | LL_TRUNCATE |
        LL_REMOVE | LL_REMOVE_DIR | LL_MAKE_DIR | LL_MAKE_REG, 0);
    if (syscall(__NR_landlock_restrict_self, rules, 0) < 0) die("enforce filesystem ruleset");
    close(rules);
    if (chdir(job)) die("enter job directory");
    restrict_syscalls();
    char heap_flag[96], parser[4096];
    snprintf(heap_flag, sizeof(heap_flag), "--max-old-space-size=%lu", heap);
    if (snprintf(parser, sizeof(parser), "%s/%s", code, entry) >= (int)sizeof(parser)) die("job entry path too long");
    /* Parsing does not need host OpenSSL engines/configuration or credentials. */
    char *const child[] = {node, "--openssl-config=/dev/null", heap_flag, parser, job,
        strcmp(entry, "parser.js") == 0 ? argv[6] : NULL, NULL};
    execv(node, child);
    die("execute parser");
}
