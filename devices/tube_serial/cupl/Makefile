WINCUPL:=C:\Wincupl
CUPL:=$(WINCUPL)\Shared\cupl.exe
CUPL_DL:=$(WINCUPL)\Shared\cupl.dl

.PHONY:build
build:
# -j   JEDEC output (jedec compatible programming file)
# -l   listing file (generate error listing file)
# -f   fuse plot/chip diagram (attach fuse plot in documentation file)
# -x   expanded product terms (generate documentation file)
# -b   Berkeley PLA file (generate a Berkeley PLA file for fitters)
# -u   Use specified library, must immediatley preceed library name (override library specified in the environment)
# -m2  Quine-McCluskey minimization (highest memory usage and slowest.)
	"$(CUPL)" -j -l -f -x -b -m2 -u "$(CUPL_DL)" tom.pld

