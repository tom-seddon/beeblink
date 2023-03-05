# UPURS notes

1. The UPURS support uses the NMI area in page &D to load data.
   Loading into that region won't cause a crash, as it might with
   disks, but the results will probably be nonsense.
   
2. The serial connection can be a bit sensitive to programs accessing
   the user VIA. The filing system will try to rescue itself if it
   looks like things have got into trouble - this process should be
   transparent, and hopefully all you'll notice is a slight delay.
   
   One example is Exile, which writes to the user VIA as part of its
   sideways RAM detection.

