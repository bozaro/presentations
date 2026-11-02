#!/usr/bin/env python3
# -*- coding: utf8 -*-
import os.path


def create(dir: str, name: str, commit: str):
    path = os.path.join(dir, ".git/refs/heads", name)
    os.makedirs(os.path.dirname(path), 0o755, True)
    with open(path, "wb") as f:
        f.write(b"%s\n" % commit.encode("utf-8"))
    print(commit, "<==", name)
