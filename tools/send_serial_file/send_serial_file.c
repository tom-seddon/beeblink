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

#ifndef B115200
#error must support 115200 baud
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
    const char*device_path;
    const char*file_path;
    size_t n;
};
typedef struct Options Options;

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static int GetOptions(Options*options,int argc,char*argv[]){
    int ch;
    while((ch=getopt(argc,argv,"hvri:n:"))!=-1){
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

        case 'h':
            options->help=1;
        case '?':
        default:
        error:
            printf("usage: send_serial_file [-h] [-v] [-r] [-n N] [-i FILE] DEVICE\n");
            printf("\n");
            printf("positional arguments:\n");
            printf("  DEVICE        open DEVICE as serial port\n");
            printf("\n");
            printf("optional arguments:\n");
            printf("  -h            show this help  message and exit\n");
            printf("  -v            be more verbose\n");
            printf("  -r            open for read as well as write\n");
            printf("  -n N          if polling for CTS, send up to N bytes (default: 1) when ready\n");
            printf("  -i FILE       send FILE\n");
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
    printf("%s\n",message);

#define BIT(X)                                  \
    do{                                         \
        if(t->FIELD&(X)){                     \
            printf(" %s",#X);                 \
        }                                       \
    }while(0)

    printf("    c_iflag: %lu (0x%lx):",t->c_iflag,t->c_iflag);
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

    printf("    c_oflag: %lu (0x%lx):",t->c_oflag,t->c_oflag);
#define FIELD c_oflag
    BIT(OPOST);   /* enable following output processing */
    BIT(ONLCR);   /* map NL to CR-NL (ala CRMOD) */
    BIT(OXTABS);  /* expand tabs to spaces */
    BIT(ONOEOT);  /* discard EOT's ‘^D’ on output) */
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
    printf("    c_cflag: %lu (0x%lx): CSIZE=",t->c_cflag,t->c_cflag);
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
    BIT(CCTS_OFLOW);  /* CTS flow control of output */
#if CRTSCTS!=CCTS_OFLOW&&CRTSCTS!=CRTS_IFLOW&&CRTSCTS!=(CCTS_OFLOW|CCTS_IFLOW)
    BIT(CRTSCTS);     /* same as CCTS_OFLOW */
#endif
    BIT(CRTS_IFLOW);  /* RTS flow control of input */
    BIT(MDMBUF);      /* flow control output via Carrier */
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

    VERBOSE("Opening device: %s\n",options.device_path);

    int port_fd=open(options.device_path,oflag);
    if(port_fd==-1){
        FailErrno("open device: %s",options.device_path);
    }

    VERBOSE("    port_fd=%d\n",port_fd);

    struct termios tio;
    if(tcgetattr(port_fd,&tio)==-1){
        FailErrno("tcgetattr for device: %s",options.device_path);
    }

    DumpTermios("initial termios state",&tio);

    /* Attempt to set RTS/CTS, 115200 baud. */
    tio.c_cflag|=CRTSCTS;
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

    int set_rtscts;
    if((tio.c_cflag&CRTSCTS)!=CRTSCTS){
        fprintf(stderr,"WARNING: couldn't set CRTSCTS. Will attempt to poll.\n");
        set_rtscts=0;
    }else{
        set_rtscts=1;
    }

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

        for(;;){
            ssize_t num_buffer_bytes=read(file_fd,buffer,sizeof buffer);
            if(num_buffer_bytes<0){
                FailErrno("read from file: %s",options.file_path);
            }else if(num_buffer_bytes==0){
                break;
            }

            num_bytes+=(size_t)num_buffer_bytes;

            if(set_rtscts){
                size_t i=0;
                while(i<(size_t)num_buffer_bytes){
                    ssize_t write_result=write(
                        port_fd,
                        buffer+i,
                        (size_t)num_buffer_bytes-i);
                    if(write_result==-1){
                        FailErrno("write to port: %s",options.device_path);
                    }

                    i+=write_result;
                }
            }else{
                size_t i=0;
                while(i<(size_t)num_buffer_bytes){
                    // Wait for CTS.
                    int cm;
                    do{
                        int rc=ioctl(port_fd,TIOCMGET,&cm);
                        if(rc==-1){
                            FailErrno("TIOCMGET for device: %s",options.device_path);
                        }
                    }while(!(cm&TIOCM_CTS));

                    // Send byte(s).
                    size_t n=options.n;
                    if(n==0){
                        n=1;
                    }
                    
                    ssize_t write_result=write(port_fd,buffer+i,n);
                    if(write_result==-1){
                        FailErrno("write to port: %s",options.device_path);
                    } else if(write_result==0){
                        Fail("result was %zd from writing to port: %s",write_result,options.device_path);
                    }

                    i+=n;
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

        close(file_fd),file_fd=-1;
    }

    close(port_fd),port_fd=-1;
}
