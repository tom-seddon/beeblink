# Useful server command line options

The server looks for volumes in the folders you specify on the command
line. You can specify multiple folders, and they'll be searched for
volumes in that order.

You can end up with multiple volumes with the same name this way,
which you can see from the `*VOLS` output or in the volume browser.
When loading a volume with `*VOL`, the first one matched will be used,
but you can use the volume browser to be explicit.

Use `--mount` to get the server to load a specific volume on startup
(following the same rules in case of ambiguity). The default is
`65boot`.

Use `--rom` to tell the server where to find the BLFS ROM image. This
is the ROM it will send to the bootstrap program, or when using
`*BLSELFUPDATE`.

# Other options

You can get a full list of the command line options with `npm start --
-h`.
