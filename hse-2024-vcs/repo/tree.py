#!/usr/bin/env python3
# -*- coding: utf8 -*-
import object


# create([
#   (0o100755, "bar.sh",  "74afc74214c6dd572ff137f5018a96407f20b92e"), # blob
#   (0o100644, "foo.txt", "964880834baa20ccfd5865121f60c9ea9c62f5ff"), # blob
#   (0o040000, "subdir",  "840613015b2fe6287427884150e5ebd55c1b8574"), # tree
#   (0o160000, "submod",  "aa2d6217394ba004578be6a83fcd33aa8db22b20"), # commit
# ])
def create(dir: str, tree):
    data = b""
    for (attr, name, hash) in tree:
        data += b"%o %s\0%s" % (attr, name.encode("utf-8"), bytes.fromhex(hash))
    return object.write(dir, "tree", data)
