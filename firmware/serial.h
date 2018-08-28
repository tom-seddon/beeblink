#ifndef HEADER_BADC5692443744979F6B4B5DD4229709
#define HEADER_BADC5692443744979F6B4B5DD4229709

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
// Copyright (C) 2018 Tom Seddon
// 
// This program is free software: you can redistribute it and/or
// modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
// 
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with this program. If not, see
// <https://www.gnu.org/licenses/>.
//
//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#ifndef SERIAL_ENABLED
#define SERIAL_ENABLED 1
#endif

#if SERIAL_ENABLED

void serial_init(void);
void serial_ch(char ch);
void serial_ps(const char *ps);
void serial_u8(uint8_t u);
void serial_u16(uint16_t u);
void serial_u32(uint32_t u);
void serial_x4(uint8_t x);
void serial_x8(uint8_t x);
void serial_x16(uint16_t x);
void serial_x24(uint32_t l);
void serial_x32(uint32_t l);

#else

#define serial_init() ((void)0)
#define serial_ps(X) ((void)0)
#define serial_u16(X) ((void)0)
#define serial_u32(X) ((void)0)
#define serial_x4(X) ((void)0)
#define serial_x8(X) ((void)0)
#define serial_x16(X) ((void)0)
#define serial_x24(X) ((void)0)
#define serial_x32(X) ((void)0)

#endif

#define SERIAL_PSTR(X) (serial_ps(PSTR(X)))

#endif
