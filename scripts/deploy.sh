#!/bin/bash

# destroy gh-pages on remote, to avoid futzing around
git push origin :gh-pages

# build the demo
gobble build dist -f

# commit and push subtree to gh-pages
git add dist -f
git commit -m 'update demo'
git subtree push --squash --prefix dist origin gh-pages