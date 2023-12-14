# [Git](https://git-scm.com/) interop

Specify `--git` when launching the server to have BeebLink look after
your Beeb files' `.gitattribute` settings. The server will try to
ensure that your Git-controlled Beeb files have their text flag reset
(inhibiting newline conversion), and will also try to add a
`diff=bbcbasic` attribute to any BBC BASIC files (see below).

This applies to any Beeb files in a volume that appears to be part of
a Git repo - i.e., any volume that has a `.git` folder in one of its
parent folders. 

The `.gitattributes` files are updated at the following times:

* on startup (reset text flag, find BASIC files)
* when saving files from the Beeb (reset text flag, find BASIC files)
* when loading a volume with `*VOL` (reset text flag)
* when creating a new volume with `*NEWVOL` (reset text flag)
* when renaming files from the Beeb (name is updated)
* when deleting files from the Beeb (file's entry is removed)

Notes:

* the server only spots changes based on Beeb activity - changing
  files on the PC won't get noticed until it does an exhaustive scan
  on the next startup
* the exhaustive scan only ever adds entries, so if renaming or
  deleting BBC files via the shell you can end up with stale
  `.gitattributes` entries. This isn't usually a problem in practice
  though
* the server pays no attention to `.gitignore`, and always updates
  `.gitattributes` even if the files are already covered by a
  perfectly good `.gitattributes` file elsewhere
* the `.gitattributes` files in volume folders are owned by Beeblink,
  and not designed for editing. The server will blithely add and
  remove entries as it sees fit

## `diff=bbcbasic`

The `diff=bbcbasic` flag lets you use a git diff driver to get text
diffs of tokenized BBC BASIC files. It's designed for use with
BBCBasicToText, as described here:
https://github.com/tom-seddon/beeb/tree/master/bin#bbcbasictotext

Example output once it's up and running:

    % git diff -p
    diff --git a/stuff/65boot/0/$.RESETCMOS b/stuff/65boot/0/$.RESETCMOS
    index b60d5083..f9c869c3 100644
    --- a/stuff/65boot/0/$.RESETCMOS
    +++ b/stuff/65boot/0/$.RESETCMOS
    @@ -1,4 +1,5 @@
     REM>RESETCMOS
    +REM TEST
     MODE7
     FORI%=0TO15
     PROCO("INSERT "+STR$I%)
	
Strongly recommended!
