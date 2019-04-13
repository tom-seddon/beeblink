#!/usr/bin/python
import sys,argparse,hashlib

def main(options):
    for path in options.paths:
        with open(path,'rb') as f: data=f.read()

        for exclude in options.excludes: data=data.replace(exclude,'')

        m=hashlib.sha1()
        m.update(data)
        print '%s  %s'%(m.hexdigest(),path)

        # with open('%s.%s'%(path,m.hexdigest()),'wb') as f: f.write(data)
        
##########################################################################
##########################################################################
    
if __name__=='__main__':
    parser=argparse.ArgumentParser()

    parser.add_argument('-x','--exclude',dest='excludes',action='append',metavar='STR',help='exclude %(metavar)s, if found, from the hash')

    parser.add_argument('paths',metavar='FILE',nargs='+',help='read data from %(metavar)s')
    
    main(parser.parse_args())
    
