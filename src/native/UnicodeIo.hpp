#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <string>
#include <string_view>
#include <vector>
#include <stdexcept>
#include <filesystem>
#include <regex>
#include <utility>
#pragma comment(lib,"bcrypt.lib")
namespace yijian {
constexpr size_t MaxSave=33554432;
struct Handle {
  HANDLE h=INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE value):h(value){}
  ~Handle(){if(h!=INVALID_HANDLE_VALUE)CloseHandle(h);}
  Handle(const Handle&)=delete;
};
inline std::wstring utf16(std::string_view bytes) {
  if(bytes.empty() || bytes.size()>131072 || bytes.find('\0')!=bytes.npos)throw std::runtime_error("invalid UTF-8 path");
  int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,bytes.data(),static_cast<int>(bytes.size()),nullptr,0);
  if(!n)throw std::runtime_error("invalid UTF-8 path");
  std::wstring s(n,L'\0');
  if(!MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,bytes.data(),static_cast<int>(bytes.size()),s.data(),n))throw std::runtime_error("invalid UTF-8 path");
  return s;
}
inline std::wstring checked_path(std::wstring s) {
  std::replace(s.begin(),s.end(),L'/',L'\\');
  if(s.size()<4 || s.size()>32700 || !((s[0]>=L'A'&&s[0]<=L'Z')||(s[0]>=L'a'&&s[0]<=L'z')) ||
     s[1]!=L':' || s[2]!=L'\\')throw std::runtime_error("drive path required");
  if(s.back()==L'\\')s.pop_back();
  size_t begin=3;
  while(begin<s.size()) {
    const size_t end=s.find(L'\\',begin), count=(end==s.npos?s.size():end)-begin;
    const auto part=s.substr(begin,count);
    if(count==0 || count>255 || part.back()==L'.' || part.back()==L' ' ||
       std::regex_match(part,std::wregex(L"(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?",std::regex::icase)))
      throw std::runtime_error("unsafe path component");
    for(const auto c:part)if(c<32 || c==127 || std::wstring_view(L"<>\":|?*").find(c)!=std::wstring_view::npos)throw std::runtime_error("unsafe path character");
    begin=(end==s.npos?s.size():end+1);
  }
  return s;
}
inline std::wstring wide(const std::wstring& p){return L"\\\\?\\"+p;}
inline void no_reparse(const std::wstring& p,bool allow_missing_leaf=false) {
  size_t end=3;
  for(;;) {
    end=p.find(L'\\',end); const bool leaf=end==p.npos;
    const auto prefix=p.substr(0,leaf?p.size():end);
    const DWORD attributes=GetFileAttributesW(wide(prefix).c_str());
    if(attributes==INVALID_FILE_ATTRIBUTES) {
      const auto error=GetLastError();
      if(leaf && allow_missing_leaf && (error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND))return;
      throw std::runtime_error("path unavailable");
    }
    if(attributes&FILE_ATTRIBUTE_REPARSE_POINT)throw std::runtime_error("reparse path rejected");
    if(!leaf && !(attributes&FILE_ATTRIBUTE_DIRECTORY))throw std::runtime_error("invalid parent directory");
    if(leaf)return;
    ++end;
  }
}
struct Bytes { std::string value; bool missing=false; };
inline void same_handle_path(HANDLE file,const std::wstring& expected) {
  std::wstring actual(32768,L'\0');
  const DWORD n=GetFinalPathNameByHandleW(file,actual.data(),static_cast<DWORD>(actual.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  if(!n||n>=actual.size())throw std::runtime_error("final path unavailable");
  actual.resize(n);
  if(actual.starts_with(L"\\\\?\\"))actual.erase(0,4);
  if(CompareStringOrdinal(actual.data(),static_cast<int>(actual.size()),expected.data(),static_cast<int>(expected.size()),TRUE)!=CSTR_EQUAL)
    throw std::runtime_error("redirected handle rejected");
}
inline Bytes read_file(const std::wstring& p,size_t limit) {
  if(limit>MaxSave)throw std::runtime_error("read limit");
  no_reparse(p,true);
  Handle file(CreateFileW(wide(p).c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  if(file.h==INVALID_HANDLE_VALUE) {
    const auto error=GetLastError();
    if(error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND)return {{},true};
    throw std::runtime_error("read unavailable");
  }
  same_handle_path(file.h,p);
  BY_HANDLE_FILE_INFORMATION before{},after{};
  if(!GetFileInformationByHandle(file.h,&before) || (before.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)) ||
     before.nFileSizeHigh || before.nFileSizeLow>limit)throw std::runtime_error("invalid file");
  std::string bytes(before.nFileSizeLow,'\0'); size_t offset=0;
  while(offset<bytes.size()) {
    DWORD got=0;
    if(!ReadFile(file.h,bytes.data()+offset,static_cast<DWORD>(bytes.size()-offset),&got,nullptr)||!got)throw std::runtime_error("short read");
    offset+=got;
  }
  if(!GetFileInformationByHandle(file.h,&after) || before.nFileSizeHigh!=after.nFileSizeHigh ||
     before.nFileSizeLow!=after.nFileSizeLow || before.dwVolumeSerialNumber!=after.dwVolumeSerialNumber ||
     before.nFileIndexHigh!=after.nFileIndexHigh || before.nFileIndexLow!=after.nFileIndexLow ||
     before.ftLastWriteTime.dwLowDateTime!=after.ftLastWriteTime.dwLowDateTime ||
     before.ftLastWriteTime.dwHighDateTime!=after.ftLastWriteTime.dwHighDateTime)throw std::runtime_error("unstable file");
  return {std::move(bytes),false};
}
inline void write_file(const std::wstring& p,std::string_view bytes) {
  if(bytes.size()>MaxSave)throw std::runtime_error("write limit");
  no_reparse(p,true);
  std::array<unsigned char,16> random{};
  if(BCryptGenRandom(nullptr,random.data(),static_cast<ULONG>(random.size()),BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0)throw std::runtime_error("random failure");
  std::wstring temp=p+L".";
  constexpr wchar_t hex[]=L"0123456789abcdef";
  for(const auto value:random){temp+=hex[value>>4];temp+=hex[value&15];}
  temp+=L".tmp";
  {
    Handle file(CreateFileW(wide(temp).c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    if(file.h==INVALID_HANDLE_VALUE)throw std::runtime_error("write unavailable");
    same_handle_path(file.h,temp);
    DWORD wrote=0;
    if(!WriteFile(file.h,bytes.data(),static_cast<DWORD>(bytes.size()),&wrote,nullptr) || wrote!=bytes.size() ||
       !FlushFileBuffers(file.h))throw std::runtime_error("write failed");
  }
  no_reparse(p,true);
  if(!MoveFileExW(wide(temp).c_str(),wide(p).c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))throw std::runtime_error("replace failed");
  const auto result=read_file(p,MaxSave);
  if(result.missing||result.value!=bytes)throw std::runtime_error("verification failed");
}
inline std::string hmac(std::string_view keyHex,std::string_view bytes) {
  if(!std::regex_match(std::string(keyHex),std::regex("[a-f0-9]{64}")))throw std::runtime_error("invalid key");
  std::array<unsigned char,32> key{},digest{}; const std::string hex="0123456789abcdef";
  for(size_t i=0;i<key.size();++i)key[i]=static_cast<unsigned char>((hex.find(keyHex[2*i])<<4)|hex.find(keyHex[2*i+1]));
  BCRYPT_ALG_HANDLE alg=nullptr; BCRYPT_HASH_HANDLE hash=nullptr;
  if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,nullptr,BCRYPT_ALG_HANDLE_HMAC_FLAG)<0)throw std::runtime_error("HMAC unavailable");
  const auto result=BCryptCreateHash(alg,&hash,nullptr,0,key.data(),static_cast<ULONG>(key.size()),0);
  bool ok=result>=0;
  if(ok)ok=BCryptHashData(hash,reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())),static_cast<ULONG>(bytes.size()),0)>=0 &&
           BCryptFinishHash(hash,digest.data(),static_cast<ULONG>(digest.size()),0)>=0;
  if(hash)BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(alg,0);
  if(!ok)throw std::runtime_error("HMAC failed");
  std::string out; for(const auto c:digest){out+=hex[c>>4];out+=hex[c&15];} return out;
}
inline bool secure_equal(std::string_view a,std::string_view b) {
  if(a.size()!=b.size())return false; unsigned char difference=0;
  for(size_t i=0;i<a.size();++i)difference|=static_cast<unsigned char>(a[i]^b[i]); return difference==0;
}
inline bool equal_path(const std::wstring& a,const std::wstring& b) {
  return CompareStringOrdinal(a.data(),static_cast<int>(a.size()),b.data(),static_cast<int>(b.size()),TRUE)==CSTR_EQUAL;
}
}
