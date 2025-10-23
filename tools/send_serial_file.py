#!/usr/bin/python3
import sys,argparse,termios,re

# in theory you could do this from the shell - but macOS resets the
# serial port properties when closed, so it's a bind.

##########################################################################
##########################################################################

# g_verbose=False

# def pv(x):
#     if g_verbose:
#         sys.stdout.write(x)
#         sys.stdout.flush()

##########################################################################
##########################################################################

# extract speeds list from termios
b_re=re.compile(r'''B(?P<baud>[0-9]+)''')
g_baud_by_Bvalue={}
for name in dir(termios):
    m=b_re.match(name)
    if m is not None:
        Bvalue=getattr(termios,name)
        baud=int(m.group('baud'))
        assert Bvalue not in g_baud_by_Bvalue
        g_baud_by_Bvalue[Bvalue]=baud

g_bits_by_CSIZE={
    termios.CS5:5,
    termios.CS6:6,
    termios.CS7:7,
    termios.CS8:8,
}

##########################################################################
##########################################################################

def print_tcattr(attrs):
    def flags(index,prefix,names):
        flags=[]
        for name in names:
            if attrs[index]&getattr(termios,name): flags.append(name)
        print('    %s: %d (0x%x): %s'%(prefix,
                                       attrs[index],
                                       attrs[index],
                                       ' '.join(flags)))
    
    flags(0,'iflag',['IGNBRK','BRKINT','IGNPAR','PARMRK','INPCK','ISTRIP','INLCR','IGNCR','ICRNL','IXANY','IXOFF'])
    flags(1,'oflag',['OPOST','ONLCR','OCRNL','ONOCR','ONLRET','OFILL','OFDEL','NLDLY','CRDLY','TABDLY','BSDLY','VTDLY','FFDLY'])
    flags(2,'cflag',['CSTOPB','CREAD','PARENB','PARODD','HUPCL','CLOCAL','CRTSCTS'])
    print('           CSIZE: %d'%g_bits_by_CSIZE.get(attrs[2]&termios.CSIZE,-1))
    flags(3,'lflag',['ISIG','ICANON','ECHO','ECHOE','ECHOK','ECHONL','NOFLSH','TOSTOP','IEXTEN'])
    print('    ispeed: %d'%g_baud_by_Bvalue.get(attrs[4],-1))
    print('    ospeed: %d'%g_baud_by_Bvalue.get(attrs[5],-1))

def main2(options):
    # global g_verbose;g_verbose=options.verbose

    print('Opening port: %s'%options.port_path)
    with open(options.port_path,'w+b',buffering=0) as port_f:
        termios.tcflush(port_f,termios.TCIOFLUSH)
        
        attrs=termios.tcgetattr(port_f)

        print('Initial settings for %s:'%options.port_path)
        print_tcattr(attrs)

        attrs[2]&=~termios.CSIZE
        attrs[2]|=termios.CS8
        attrs[2]|=termios.CRTSCTS
        attrs[4]=termios.B115200
        attrs[5]=termios.B115200

        print('Updated settings for %s:'%options.port_path)
        print_tcattr(attrs)

        termios.tcsetattr(port_f,termios.TCSANOW,attrs)

        for input_path in options.input_paths:
            print('Sending: %s...'%input_path)
            with open(input_path,'rb') as f: data=f.read()
            print('    %d byte(s)'%len(data))

            port_f.write(data)

##########################################################################
##########################################################################

def main(argv):
    parser=argparse.ArgumentParser()
    # parser.add_argument('-v','--verbose',action='store_true',help='''be more verbose''')
    parser.add_argument('-i','--input-file',metavar='FILE',action='append',dest='input_paths',default=[],help='''send %(metavar)s (can specify multiple times)''')
    parser.add_argument('port_path',metavar='FILE',help='''open %(metavar)s as serial port''')

    main2(parser.parse_args(argv))

##########################################################################
##########################################################################

if __name__=='__main__': main(sys.argv[1:])
