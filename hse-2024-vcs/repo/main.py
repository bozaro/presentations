#!/usr/bin/env python3
# -*- coding: utf8 -*-

import tree, blob, repo, commit, branch

dir = "."
repo.create(dir)
foo = blob.create(dir, b"Git repo from scratch\n")
barv1 = blob.create(dir, b"Lorem\nippsum\ndolor\nsit\namet\n")
barv2 = blob.create(dir, b"Lorem\nipsum\ndolor\nsit\namet\n")

t1 = tree.create(dir, [
    (0o100644, "bar.txt", barv1),
    (0o100644, "foo.txt", foo),
])
c1 = commit.create(dir, t1, [], "Artem <bozaro@yandex.ru> 1696268685 +0300", "Commit 1")

t2 = tree.create(dir, [
    (0o040000, "bar", tree.create(dir, [
        (0o100644, "bar.txt", barv2),
    ])),
    (0o100644, "foo.txt", foo),
])
c2 = commit.create(dir, t2, [c1], "Artem <bozaro@yandex.ru> 1696662204 +0300", "Minor fix")
c3 = commit.create(dir, t2, [c1, c2], "Artem <bozaro@yandex.ru> 1696662427 +0300", "Merge")
branch.create(dir, "demo", c3)
