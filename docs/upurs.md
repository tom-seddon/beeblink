# UPURS notes

1. The UPURS support uses the NMI area in page &D to load data. This
   shouldn't be a problem in practice, as any disk-based software has
   to avoid overwriting this region, but it is a restriction that
   doesn't apply to the Tube Serial version
   
2. The serial connection can be a bit sensitive to programs accessing
   the user VIA. The filing system will try to rescue itself if it
   looks like things have got into trouble - this process should be
   transparent, and hopefully all you'll notice is a slight delay.
   
   One example is Exile, which writes to the user VIA as part of its
   sideways RAM detection.

