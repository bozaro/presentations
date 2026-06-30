#!/usr/bin/env python3
# -*- coding: utf8 -*-
import os.path


def create(dir: str):
    os.makedirs(os.path.join(dir, ".git/refs"), 0o755, True)
    os.makedirs(os.path.join(dir, ".git/objects"), 0o755, True)
    head = os.path.join(dir, ".git/HEAD")
    if not os.path.exists(head):
        with open(head, "wt") as f:
            f.write("ref: refs/heads/master")
