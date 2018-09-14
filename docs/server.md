# Useful server command line options

The server looks for volumes in the folders you specify on the command
line. You can specify multiple folders, and they'll be searched for
volumes in that order.

You can end up with multiple volumes with the same name this way,
which you can see from the `*VOLS` output or in the volume browser.
When loading a volume with `*VOL`, the first one matched will be used,
but you can use the volume browser to be explicit.

Use `--default-volume` to get the server to load a specific volume on
startup (following the same rules in case of ambiguity). The default
is `65boot`.

Use `--rom` to tell the server where to find the BLFS ROM image. It
will then try to load it from this location, not the current folder,
when using the bootstrap program or `*BLSELFUPDATE`.

# Using a config file

You can create a config file to avoid having to specify folders on the
command line each time. The server will try to load this automatically
on startup each time.

The server can create the config file for you based on the command
line options you provide. Use the `--save-config` option to do this.
It will save the options to `beeblink_config.json`, which is the file
it tries to load on startup each time.

You can also specify config file names manually if you prefer - see
the help.

# Help

You can get a full list of the command line options with `npm start --
-h`.
