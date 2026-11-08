#!/bin/sh -ex
cd "$(dirname "$0")"

HUGO_VER=0.119.0
BUILD_DIR=.build/hugo_${HUGO_VER}_linux_amd64
HUGO_BIN=${BUILD_DIR}/hugo
# архив, положенный в репозиторий через git-lfs (основной источник - CI может быть без выхода в интернет)
LFS_TGZ=.jenkins/distrib/hugo_${HUGO_VER}_Linux-64bit.tar.gz

# первые два байта gzip-а; текстовый указатель git-lfs ими не начинается
is_gzip() {
    [ -f "$1" ] && [ "$(head -c 2 "$1" | od -An -tx1 | tr -dc '0-9a-f')" = "1f8b" ]
}

if [ ! -x "$HUGO_BIN" ]; then
    if [ ! -e "$LFS_TGZ" ] || ! is_gzip "$LFS_TGZ"; then
        # в клоне мог остаться указатель вместо бинарника (git clone без smudge)
        git lfs checkout "$LFS_TGZ" || true
    fi

    if is_gzip "$LFS_TGZ"; then
        TGZ="$LFS_TGZ"
    else
        # скачиваем во временный (не отслеживаемый git-ом) каталог,
        # чтобы не портить содержимое LFS_TGZ, которое лежит в индексе
        TGZ=${BUILD_DIR}/hugo_${HUGO_VER}_Linux-64bit.tar.gz
        mkdir -p "$BUILD_DIR"
        curl -fL -o "${TGZ}~" \
            "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VER}/hugo_${HUGO_VER}_Linux-64bit.tar.gz"
        mv "${TGZ}~" "$TGZ"
    fi

    if ! is_gzip "$TGZ"; then
        echo "не удалось получить hugo ${HUGO_VER}: $TGZ не является gzip-архивом" >&2
        echo "проверьте git-lfs: git lfs install --local && git lfs pull" >&2
        exit 1
    fi

    mkdir -p "$BUILD_DIR"
    tar -xzf "$TGZ" -C "$BUILD_DIR"
fi

"$HUGO_BIN" "$@"
if [ -d public ]; then
    find public -iname .git -delete

    # self-hosted MathJax: в публикацию не идёт ничего лишнего
    #   unpacked/ (22M, 1218 файлов) - исходники для отладки, packed MathJax.js их не грузит
    #   test/     (108K, 20 файлов)  - тесты MathJax
    #   fonts/**/png (116M, 29012 файлов) - bitmap-фоллбэк для браузеров без @font-face;
    #       woff/otf/eot/svg остаются, на современных браузерах рендер не зависит от png
    if [ -d public/mathjax ]; then
        rm -rf public/mathjax/unpacked public/mathjax/test
        find public/mathjax/fonts -type d -name png -prune -exec rm -rf {} \;
    fi
fi
