#!/usr/bin/python
import os,sys,argparse,re

##########################################################################
##########################################################################

def get_c(name,value): return "#define %s (%s)"%(name,value)

def get_6502(name,value):
    if value.startswith('0x'): value='$'+value[2:]
    return "%s=%s"%(name,value)

g_languages={
    'c':get_c,
    '6502':get_6502,
}

##########################################################################
##########################################################################

def bol(): return "^"
def spaces(): return "[ \\t]+"
def maybe_space(): return "[ \\t]*"
def group(name,r): return "(?P<%s>%s)"%(name,r)
def quote(str): return re.escape(str)
def ident(): return "([A-Za-z_][A-Za-z_0-9]*)"
def number(): return "(([0-9]+)|(0x[0-9A-Fa-f]+))"

k_re_str=(bol()+
          maybe_space()+
          quote('export')+
          spaces()+
          quote('const')+
          spaces()+
          group('name',ident())+
          maybe_space()+
          quote('=')+
          maybe_space()+
          group('value',number())+
          maybe_space()+
          ';')
# print k_re_str
k_re=re.compile(k_re_str)

def do_output(f,lines,options):
    fun=g_languages[options.output_language]
    for line in lines:
        m=k_re.match(line)
        if m is not None:
            print>>f,fun(m.group('name'),m.group('value'))

def main(options):
    if options.output_language not in g_languages:
        print>>sys.stderr,'FATAL: unrecognised language: %s'%options.output_language
        sys.exit(1)

    with open(options.input_file_path,'rt') as f:
        lines=[line.strip() for line in f.readlines()]

    if options.output_file_path is None: do_output(sys.stdout,lines,options)
    else:
        with open(options.output_file_path,'wt') as f: do_output(f,lines,options)

        
##########################################################################
##########################################################################

if __name__=="__main__":
    parser=argparse.ArgumentParser(description="make BeebLink constants file")

    parser.add_argument('-o',
                        dest='output_file_path',
                        metavar='FILE',
                        default=None,
                        help='file to write output to, or stdout if not specified')
    parser.add_argument('input_file_path',
                        metavar='FILE',
                        help='TypeScript constants file to read from')
    parser.add_argument('output_language',
                        metavar='LANG',
                        help='language to output - one of %s'%(','.join(sorted(g_languages.keys()))))
    
    main(parser.parse_args(sys.argv[1:]))
    
