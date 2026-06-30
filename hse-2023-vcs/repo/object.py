# -*- coding: utf8 -*-
import hashlib
import os.path
import zlib


def write(dir: str, kind: str, data: bytes):
    object = b"%s %d\0%s" % (kind.encode("utf-8"), len(data), data)
    hash = hashlib.sha1(object).hexdigest()
    path = os.path.join(dir, ".git/objects/%s/%s" %
                        (hash[:2], hash[2:]))
    os.makedirs(os.path.dirname(path), 0o755, True)
    with open(path, "wb") as f:
        f.write(zlib.compress(object, zlib.Z_BEST_COMPRESSION))
    print(hash, kind)
    return hash
