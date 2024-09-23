#!/usr/bin/env python3
# -*- coding: utf8 -*-
import object


def create(dir: str, data: bytes):
    return object.write(dir, "blob", data)
