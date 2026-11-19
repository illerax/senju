#!/usr/bin/env python3
"""A FUSE file system that behaves like a network share on a bad link.

Usage: flakyfs.py <mountpoint> <mode file>
The mode file holds "online", "slow <ms>" or "offline". Offline requests hang
until the mode changes, like an NFS hard mount whose server went away.
The tree: / and /project are directories, nothing else exists.
"""
import os, socket, struct, subprocess, sys, threading, time

mnt, mode_file = sys.argv[1], sys.argv[2]

parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
os.set_inheritable(child.fileno(), True)
env = dict(os.environ, _FUSE_COMMFD=str(child.fileno()))
proc = subprocess.Popen(['fusermount3', '-o', 'fsname=flakyfs,subtype=flakyfs', '--', mnt], env=env, pass_fds=[child.fileno()])
_, fds, _, _ = socket.recv_fds(parent, 16, 1)
proc.wait()
dev = fds[0]

IN = struct.Struct('<IIQQIIII')
OUT = struct.Struct('<IiQ')
lock = threading.Lock()
uid, gid = os.getuid(), os.getgid()
now = int(time.time())


def mode():
    try:
        return open(mode_file).read().split()
    except OSError:
        return ['online']


def reply(unique, error=0, body=b''):
    with lock:
        try:
            os.write(dev, OUT.pack(OUT.size + len(body), -error, unique) + body)
        except OSError:
            pass


def attr(ino):
    return struct.pack('<QQQQQQIIIIIIIIII', ino, 0, 0, now, now, now, 0, 0, 0, 0o40755, 2, uid, gid, 0, 4096, 0)


def handle(op, unique, nodeid, body):
    m = mode()
    while m[0] == 'offline':
        time.sleep(0.05)
        m = mode()
    if m[0] == 'slow':
        time.sleep(int(m[1]) / 1000)
    if op == 1:  # LOOKUP
        name = body.split(b'\0')[0]
        if nodeid == 1 and name == b'project':
            reply(unique, body=struct.pack('<QQQQII', 2, 0, 0, 0, 0, 0) + attr(2))
        else:
            reply(unique, 2)  # ENOENT
    elif op == 3:  # GETATTR
        reply(unique, body=struct.pack('<QII', 0, 0, 0) + attr(nodeid))
    elif op == 27:  # OPENDIR
        reply(unique, body=struct.pack('<QII', 0, 0, 0))
    elif op in (28, 29):  # READDIR (empty), RELEASEDIR
        reply(unique)
    else:
        reply(unique, 38)  # ENOSYS


while True:
    try:
        data = os.read(dev, 1 << 21)
    except OSError:
        break
    length, op, unique, nodeid, *_ = IN.unpack_from(data)
    body = data[IN.size:length]
    if op == 26:  # INIT: answer with protocol 7.31
        major, minor, readahead, flags = struct.unpack_from('<IIII', body)
        reply(unique, body=struct.pack('<IIIIHHIIHHI7I', 7, 31, readahead, 0, 16, 12, 1 << 17, 1, 32, 0, 0, *[0] * 7))
    elif op in (2, 42, 36):  # FORGET, BATCH_FORGET, INTERRUPT: no answer
        pass
    elif op == 38:  # DESTROY
        break
    else:
        threading.Thread(target=handle, args=(op, unique, nodeid, body), daemon=True).start()
