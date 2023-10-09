#!/bin/bash -ex
git init -b demo .
git config --local user.email bozaro@yandex.ru
git config --local user.name Artem

echo -en "Git repo from scratch\n" > foo.txt
echo -en "Lorem\nippsum\ndolor\nsit\namet\n" > bar.txt
git add foo.txt bar.txt
export GIT_COMMITTER_DATE="Mon Oct 2 20:44:45 2023 +0300"
git commit --date "$GIT_COMMITTER_DATE" -m "Commit 1"

git checkout -b fix
mkdir -p bar
mv -f bar.txt bar/bar.txt
sed -i s/ippsum/ipsum/g bar/bar.txt
git add bar.txt bar/bar.txt
export GIT_COMMITTER_DATE="Sat Oct 7 10:03:24 2023 +0300"
git commit --date "$GIT_COMMITTER_DATE" -m "Minor fix"

git checkout demo
export GIT_COMMITTER_DATE="Sat Oct 7 10:07:07 2023 +0300"
export GIT_AUTHOR_DATE="${GIT_COMMITTER_DATE}"
git merge -m "Merge" --no-ff fix

git log demo --graph --stat
