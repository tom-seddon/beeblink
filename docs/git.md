# [Git](https://git-scm.com/) interop

If using Git to track your BeebLink volumes, you probably want to set
up a [`.gitattributes` file](https://git-scm.com/docs/gitattributes)
that unsets the text flag on all your Beeb files.

Specify `--git` when launching the server to have BeebLink look after
this for you. The server will scan the available volumes on startup,
find any that appear to be part of a git repo (i.e., that have a
`.git` folder in one of their parent folders), and make sure each
volume's drive folders contain a `.gitattributes` file with `* -text`
in them. This will ensure all the Beeb files have the text flag unset.

<!-- Additional similar `.gitattribute` files will also be created for any -->
<!-- new folders created when saving files or using `*NEWVOL`, and for any -->
<!-- folders newly discovered when using `*VOL`. -->

Note that this functionality is not super-clever: it pays no attention
to `.gitignore`, and it will blithely add additional `.gitattributes`
files to folders that are already covered by a perfectly good
`.gitattributes` file elsewhere.

