#define _POSIX_C_SOURCE 199309L
#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#elif defined __linux__
#define _DEFAULT_SOURCE
#endif
#include <termios.h>
#include <unistd.h>
#include <stdio.h>
#include <fcntl.h>
#include <stdarg.h>
#include <sys/errno.h>
#include <string.h>
#include <stdlib.h>
#include <termios.h>
#include <stdint.h>
#include <sys/ioctl.h>
#include <inttypes.h>
#include <getopt.h>
#include <time.h>
#ifdef __linux__
#include <linux/serial.h>
#endif

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#ifndef B115200
#error must support 115200 baud
#endif

#ifdef TIOCMIWAIT
#define HAVE_TIOCMIWAIT (1)
#endif

#if defined TIOCGSERIAL&&defined TIOCSSERIAL&&defined ASYNC_LOW_LATENCY
#define HAVE_LOW_LATENCY (1)
#else
#define HAVE_LOW_LATENCY (0)
#endif

#ifdef MDMBUF
#define HAVE_MDMBUF (1)
#else
#define HAVE_MDMBUF (0)
#endif

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#define NORETURN __attribute__((noreturn))
#define PRINTFY(A,B) __attribute__((__format__(__printf__,(A),(B))))

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static int g_verbose=0;

#define VERBOSE(...)                            \
    do{                                         \
        if(g_verbose){                          \
            printf(__VA_ARGS__);                \
        }                                       \
    }while(0)

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static void FailMessagePrefix(const char*fmt,va_list *v){
    fprintf(stderr,"FATAL: ");

    vfprintf(stderr,fmt,*v);
    va_end(*v);
}

static NORETURN PRINTFY(1,2) void Fail(const char*fmt,...){
    va_list v;
    va_start(v,fmt);
    FailMessagePrefix(fmt,&v);

    printf("\n");

    exit(1);
}

static NORETURN PRINTFY(1,2) void FailErrno(const char*fmt,...){
    int initial_errno=errno;

    va_list v;
    va_start(v,fmt);
    FailMessagePrefix(fmt,&v);

    fprintf(stderr,": %s\n",strerror(initial_errno));

    exit(1);
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

struct Options{
    int rdwr;
    int help;
    int poll_for_cts;
    const char*device_path;
    const char*file_path;
    size_t n;
#if HAVE_LOW_LATENCY
    int low_latency;
#endif
#if HAVE_MDMBUF
    int mdmbuf;
#endif
    int exclusive;
    int nbio;
    int noctty;
};
typedef struct Options Options;

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static int GetOptions(Options*options,int argc,char*argv[]){
    int ch;
    while((ch=getopt(argc,argv,"hvri:n:pmleBC"))!=-1){
        switch(ch){
        case 'i':
            options->file_path=optarg;
            break;
            
        case 'v':
            g_verbose=1;
            break;

        case 'r':
            options->rdwr=1;
            break;

        case 'p':
            options->poll_for_cts=1;
            break;

        case 'm':
#if HAVE_MDMBUF
            options->mdmbuf=1;
#else
            fprintf(stderr,"WARNING: ignoring -m\n");
#endif

        case 'l':
#if HAVE_LOW_LATENCY
            options->low_latency=1;
#else
            fprintf(stderr,"WARNING: ignoring -l\n");
#endif
            break;

        case 'e':
            options->exclusive=1;
            break;

        case 'n':
            {
                char*ep;
                unsigned long long n=strtoull(optarg,&ep,0);
                if(*ep!=0||n<1||n>SIZE_MAX){
                    Fail("invalid number: %s",optarg);
                }
                
                options->n=(size_t)n;
            }
            break;

        case 'B':
            options->nbio=1;
            break;

        case 'C':
            options->noctty=1;
            break;

        case 'h':
            options->help=1;
        case '?':
        default:
        error:
            printf("usage: send_serial_file [-h] [-v] [-r] [-p] [-P] [-n N] [-i FILE] [-l] [-e] [-B] DEVICE\n");
            printf("\n");
            printf("positional arguments:\n");
            printf("  DEVICE        open DEVICE as serial port\n");
            printf("\n");
            printf("optional arguments:\n");
            printf("  -h            show this help  message and exit\n");
            printf("  -v            be more verbose\n");
            printf("  -r            open for read as well as write\n");
            printf("  -m            %s\n",HAVE_MDMBUF?"use MDMBUF (overrides -p)":"(ignored)");
            printf("  -p            always poll for CTS\n");
            printf("\n");
            printf("  -n N          send up to N bytes per write\n");
            printf("  -i FILE       send FILE\n");
            printf("  -l            %s\n",HAVE_LOW_LATENCY?"set low latency flag for port":"(ignored)");
            printf("  -e            put the device in exclusive mode\n");
            printf("  -B            use non-blocking I/O\n");
            printf("  -C            open device with O_NOCTTY\n");
            return 0;
        }
    }

    if(optind!=argc-1){
        goto error;
    }

    options->device_path=argv[optind];

    return 1;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////s

struct BaudRate{
    int baud;
    speed_t speed;
};
typedef struct BaudRate BaudRate;

static const BaudRate g_baud_rates[]={
    {0,B0},
    {50,B50},
    {75,B75},
    {110,B110},
    {134,B134},
    {150,B150},
    {200,B200},
    {300,B300},
    {600,B600},
    {1200,B1200},
    {1800,B1800},
    {2400,B2400},
    {4800,B4800},
    {9600,B9600},
    {19200,B19200},
#ifdef B14400B
    {14400,B14400},
#endif
#ifdef B28800B
    {28800,B28800},
#endif
#ifdef B57600B
    {57600,B57600},
#endif
#ifdef B76800B
    {76800,B76800},
#endif
    {115200,B115200},
    {-1},
};

static int GetBaudRateForSpeed(speed_t speed){
    const BaudRate*rate;
    for(rate=g_baud_rates;rate->baud>=0;++rate){
        if(rate->speed==speed){
            break;
        }
    }

    return rate->baud;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static void DumpTermios(const char*message,const struct termios*t){
    printf("%s (begin=%p; end=%p):\n",message,(void*)t,(void*)(t+1));

#define BIT(X)                                  \
    do{                                         \
        if(t->FIELD&(X)){                     \
            printf(" %s",#X);                 \
        }                                       \
    }while(0)

    printf("    c_iflag: %" PRIu64 " (0x%" PRIx64 "):",(uint64_t)t->c_iflag,(uint64_t)t->c_iflag);
#define FIELD c_iflag
    BIT(IGNBRK);   /* ignore BREAK condition */
    BIT(BRKINT);   /* map BREAK to SIGINTR */
    BIT(IGNPAR);   /* ignore (discard) parity errors */
    BIT(PARMRK);   /* mark parity and framing errors */
    BIT(INPCK);    /* enable checking of parity errors */
    BIT(ISTRIP);   /* strip 8th bit off chars */
    BIT(INLCR);    /* map NL into CR */
    BIT(IGNCR);    /* ignore CR */
    BIT(ICRNL);    /* map CR to NL (ala CRMOD) */
    BIT(IXON);     /* enable output flow control */
    BIT(IXOFF);    /* enable input flow control */
    BIT(IXANY);    /* any char will restart after stop */
    BIT(IMAXBEL);  /* ring bell on input queue full */
#ifdef IUCLC
    BIT(IUCLC);    /* translate upper case to lower case */
#else
    /* it's in the macOS man termios page, but apparently not actually
     * defined? */
#endif
#undef FIELD
    printf("\n");

    printf("    c_oflag: %" PRIu64 " (0x%" PRIx64 "):",(uint64_t)t->c_oflag,(uint64_t)t->c_oflag);
#define FIELD c_oflag
    BIT(OPOST);   /* enable following output processing */
    BIT(ONLCR);   /* map NL to CR-NL (ala CRMOD) */
#ifdef OXTABS
    BIT(OXTABS);  /* expand tabs to spaces */
#endif
#ifdef ONOEOT
    BIT(ONOEOT);  /* discard EOT's ‘^D’ on output) */
#endif
    BIT(OCRNL);   /* map CR to NL */
#ifdef OLCUC
    BIT(OLCUC);   /* translate lower case to upper case */
#else
    /* it's in the macOS man termios page, but apparently not actually
     * defined? */
#endif
    BIT(ONOCR);   /* No CR output at column 0 */
    BIT(ONLRET);  /* NL performs CR function */
#undef FIELD
    printf("\n");

#define FIELD c_cflag
    printf("    c_cflag: %" PRIu64 " (0x%" PRIx64 "): CSIZE=",(uint64_t)t->c_cflag,(uint64_t)t->c_cflag);
    switch(t->c_cflag&CSIZE){
    case CS5:
        printf("5");
        break;
        
    case CS6:
        printf("6");
        break;

    case CS7:
        printf("7");
        break;

    case CS8:
        printf("8");
        break;

    default:
        printf("?");
        break;
    }
    BIT(CSTOPB);      /* send 2 stop bits */
    BIT(CREAD);       /* enable receiver */
    BIT(PARENB);      /* parity enable */
    BIT(PARODD);      /* odd parity, else even */
    BIT(HUPCL);       /* hang up on last close */
    BIT(CLOCAL);      /* ignore modem status lines */
#ifdef CCTS_OFLOW
    BIT(CCTS_OFLOW);  /* CTS flow control of output */
#endif
#if CRTSCTS!=CCTS_OFLOW&&CRTSCTS!=CRTS_IFLOW&&CRTSCTS!=(CCTS_OFLOW|CRTS_IFLOW)
    BIT(CRTSCTS);     /* same as CCTS_OFLOW */
#endif
#ifdef CRTS_IFLOW
    BIT(CRTS_IFLOW);  /* RTS flow control of input */
#endif
#ifdef MDMBUF
    BIT(MDMBUF);      /* flow control output via Carrier */
#endif
#undef FIELD
    printf("\n");

#undef BIT

    speed_t ispeed=cfgetispeed(t);
    printf("    ispeed: %d\n",GetBaudRateForSpeed(ispeed));

    speed_t ospeed=cfgetospeed(t);
    printf("    ospeed: %d\n",GetBaudRateForSpeed(ospeed));
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static double GetSecondsForTimespec(const struct timespec *t){
    return t->tv_sec+t->tv_nsec/1e9;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#define PRINT_VALUE(NAME) (printf(#NAME "=0x%" PRIx64 " (%" PRIu64 ")\n",(uint64_t)(NAME),(uint64_t)(NAME)),(void)0)

int main(int argc,char*argv[]){
    Options options={0};
    if(!GetOptions(&options,argc,argv)){
        if(options.help){
            return 0;
        }else{
            return 1;
        }
    }

    int oflag=0;
    if(options.rdwr){
        oflag|=O_RDWR;
    }else{
        oflag|=O_WRONLY;
    }

    if(options.noctty){
        oflag|=O_NOCTTY;
    }

    if(options.nbio){
        oflag|=O_NONBLOCK;
    }

    printf("Features:");
#if HAVE_TIOCMIWAIT
    printf(" TIOCMIWAIT");
#endif
#if HAVE_LOW_LATENCY
    printf(" LOW_LATENCY");
#endif
    printf("\n");

    PRINT_VALUE(TIOCMGET);
    PRINT_VALUE(TIOCMSET);
    PRINT_VALUE(TIOCGETA);
    PRINT_VALUE(TIOCSETA);
    PRINT_VALUE(sizeof(struct termios));
    
    VERBOSE("TIOCMGET=0x%" PRIx64 "\n",(uint64_t)TIOCMGET);
    VERBOSE("TIOCMGET=0x%" PRIx64 "\n",(uint64_t)TIOCMGET);
    //VERBOSE("zzz=0x%" PRIx64 "\n",(uint64_t)(O_RDWR|O_NONBLOCK|O_NOCTTY));

    VERBOSE("Opening device: %s\n",options.device_path);

    int port_fd=open(options.device_path,oflag);
    if(port_fd==-1){
        FailErrno("open device: %s",options.device_path);
    }

    if(options.exclusive){
        if(ioctl(port_fd,TIOCEXCL)==-1){
            FailErrno("TIOCEXCL for device: %s",options.device_path);
        }
    }

    if(options.nbio){
        if(fcntl(port_fd,F_SETFL,O_NONBLOCK)==-1){
            FailErrno("F_SETFL O_NONBLOCK for device: %s",options.device_path);
        }
    }

    VERBOSE("    port_fd=%d\n",port_fd);

    struct termios tio;
    if(tcgetattr(port_fd,&tio)==-1){
        FailErrno("tcgetattr for device: %s",options.device_path);
    }

    DumpTermios("initial termios state",&tio);

    /* Attempt to set raw mode, RTS/CTS, 115200 baud. */
    cfmakeraw(&tio);
    if(options.poll_for_cts){
        tio.c_cflag&=~CRTSCTS;
    }else{
        tio.c_cflag|=CRTSCTS;
    }

#if HAVE_MDMBUF
    if(options.mdmbuf){
        tio.c_cflag&=~CRTSCTS;
        tio.c_cflag|=MDMBUF;
    }
#endif
    
    cfsetospeed(&tio,B115200);
    cfsetispeed(&tio,B115200);

    DumpTermios("intended new termios state",&tio);

    if(tcsetattr(port_fd,TCSANOW,&tio)==-1){
        FailErrno("tcsetattr for device: %s",options.device_path);
    }

    if(tcgetattr(port_fd,&tio)==-1){
        FailErrno("tcgetattr for device: %s",options.device_path);
    }

    DumpTermios("actual new termios state",&tio);

    int poll_for_cts;
    if(options.poll_for_cts){
        poll_for_cts=1;
    }else if(options.mdmbuf){
        poll_for_cts=0; 
    }else if((tio.c_cflag&CRTSCTS)!=CRTSCTS){
        fprintf(stderr,"WARNING: couldn't set CRTSCTS (wanted 0x%" PRIx64 "; got 0x%" PRIx64 "). Will poll.\n",(uint64_t)CRTSCTS,(uint64_t)(tio.c_cflag&CRTSCTS));
        poll_for_cts=1;
    }else{
        poll_for_cts=0;
    }

#if HAVE_LOW_LATENCY
    if(options.low_latency){
        struct serial_struct ss;
        if(ioctl(port_fd,TIOCGSERIAL,&ss)==-1){
            FailErrno("TIOCGSERIAL for device: %s",options.device_path);
        }

        ss.flags|=ASYNC_LOW_LATENCY;

        if(ioctl(port_fd,TIOCSSERIAL,&ss)==-1){
            FailErrno("TIOCSSERIAL for device: %s",options.device_path);
        }

        struct serial_struct ss2;
        if(ioctl(port_fd,TIOCGSERIAL,&ss2)==-1){
            FailErrno("TIOCGSERIAL (2) for device: %s",options.device_path);
        }

        if(!(ss2.flags&ASYNC_LOW_LATENCY)){
            fprintf(stderr,"WARNING: failed to set the low latency flag on device: %s\n",options.device_path);
        }
    }
#endif

    if(options.file_path){
        int file_fd=open(options.file_path,O_RDONLY);
        if(file_fd==-1){
            FailErrno("open file: %s",options.file_path);
        }

        struct timespec begin_t;
        if(clock_gettime(CLOCK_REALTIME,&begin_t)==-1){
            FailErrno("clock_gettime for begin CLOCK_REALTIME");
        }
        
        uint8_t buffer[4096];
        uint64_t num_bytes=0;
        uint64_t num_cts_false=0;

        for(;;){
            ssize_t num_buffer_bytes=read(file_fd,buffer,sizeof buffer);
            if(num_buffer_bytes<0){
                FailErrno("read from file: %s",options.file_path);
            }else if(num_buffer_bytes==0){
                break;
            }

            num_bytes+=(size_t)num_buffer_bytes;

            if(poll_for_cts){
                size_t i=0;
                while(i<(size_t)num_buffer_bytes){
#if HAVE_TIOCMIWAIT
                    
                    for(;;){
                        int cm;
                        if(ioctl(port_fd,TIOCMGET,&cm)==-1){
                            FailErrno("TIOCMGET for device: %s",options.device_path);
                        }

                        if(cm&TIOCM_CTS){
                            break;
                        }

                        if(ioctl(port_fd,TIOCMIWAIT,TIOCM_CTS)==-1){
                            FailErrno("TIOCMGET for CTS for device: %s",options.device_path);
                        }
                    }
#else
                    
                    // Poll for CTS.
                    int cm;
                    do{
                        if(ioctl(port_fd,TIOCMGET,&cm)==-1){
                            FailErrno("TIOCMGET for device: %s",options.device_path);
                        }

                        if(!(cm&TIOCM_CTS)){
                            ++num_cts_false;
                        }
                        
                        int nread;
                        if(ioctl(port_fd,FIONREAD,&nread)==-1){
                            FailErrno("FIONREAD for device: %s",options.device_path);
                        }
                    }while(!(cm&TIOCM_CTS));

#endif

                    // Send byte(s).
                    size_t n=options.n;
                    if(n==0){
                        n=1;
                    }
                    
                    ssize_t write_result=write(port_fd,buffer+i,n);
                    if(write_result==-1){
                        if(options.nbio&&errno==EWOULDBLOCK){
                            // go back to waiting...
                        }else{
                            FailErrno("write to port: %s",options.device_path);
                        }
                    } else if(write_result==0){
                        Fail("result was %zd from writing to port: %s",write_result,options.device_path);
                    }

                    i+=n;
                }
            }else{
                size_t i=0;
                while(i<(size_t)num_buffer_bytes){
                    size_t n=(size_t)num_buffer_bytes-i;
                    if(n>options.n){
                        n=options.n;
                    }
                    
                    ssize_t write_result=write(port_fd,buffer+i,n);
                    if(write_result==-1){
                        FailErrno("write to port: %s",options.device_path);
                    }

                    i+=write_result;
                }

                if(tcdrain(port_fd)==-1){
                    FailErrno("drain port: %s",options.device_path);
                }
            }
        }

        struct timespec end_t;
        if(clock_gettime(CLOCK_REALTIME,&end_t)==-1){
            FailErrno("clock_gettime for end CLOCK_REALTIME");
        }

        double num_seconds=GetSecondsForTimespec(&end_t)-GetSecondsForTimespec(&begin_t);
        
        printf("sent %" PRIu64 " bytes in %.3f seconds: ~%.3f KBytes/sec; %.1f bits/sec\n",
               num_bytes,
               num_seconds,
               num_bytes/1024./num_seconds,
               num_bytes*8./num_seconds);
        printf("CTS false count: %" PRIu64 "\n",num_cts_false);

        for(;;){
            int cm;
            if(ioctl(port_fd,TIOCMGET,&cm)==-1){
                FailErrno("TIOCMGET for device: %s",options.device_path);
            }
            printf("CTS=%d\n",!!(cm&TIOCM_CTS));
        }

        close(file_fd),file_fd=-1;
    }

    close(port_fd),port_fd=-1;
}
