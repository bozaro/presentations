#!/usr/bin/env python3
# -*- coding: utf8 -*-
import object


def create(dir: str, tree: str, parents, author: str, message: str):
    data = b""
    data += b"tree %s\n" % (tree.encode("utf-8"),)
    for parent in parents:
        data += b"parent %s\n" % (parent.encode("utf-8"),)
    data += b"author %s\n" % (author.encode("utf-8"))
    data += b"committer %s\n" % (author.encode("utf-8"))
    data += b"\n%s\n" % (message.encode("utf-8"))
    return object.write(dir, "commit", data)
