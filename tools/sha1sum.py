#!/usr/bin/python3
import sys,argparse,hashlib,collections

##########################################################################
##########################################################################

Hash=collections.namedtuple('Hash','hexdigest path size')

##########################################################################
##########################################################################

def main(options):
    hashes=[]
    for path in options.paths:
        with open(path,'rb') as f: data=f.read()

        size=len(data)

        for exclude in options.excludes:
            data=data.replace(exclude.encode('ascii'),b'')

        m=hashlib.sha1()
        m.update(data)

        hashes.append(Hash(hexdigest=m.hexdigest(),path=path,size=size))

    if options.show_size:
        max_size_len=max([len(str(hash.size)) for hash in hashes])
        for hash in hashes: print('%s  %-*d  %s'%(hash.hexdigest,
                                                  max_size_len,
                                                  hash.size,
                                                  hash.path))
    else:
        for hash in hashes: print('%s  %s'%(hash.hexdigest,hash.path))
        
##########################################################################
##########################################################################
    
if __name__=='__main__':
    parser=argparse.ArgumentParser()

    parser.add_argument('-x','--exclude',dest='excludes',action='append',metavar='STR',help='exclude %(metavar)s, if found, from the hash')
    parser.add_argument('--size',dest='show_size',action='store_true',help='show file sizes')

    parser.add_argument('paths',metavar='FILE',nargs='+',help='read data from %(metavar)s')
    
    main(parser.parse_args())
