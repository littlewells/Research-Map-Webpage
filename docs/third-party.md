# 第三方许可及对应源码

本目录的 `src/` 是 Research Map 的源代码，适用 [AGPL-3.0](../LICENSE)。`runtime/` 同时包含为 Windows x64 准备的第三方 DLL、Python 扩展和模型；即使通过 Git 下载，它们仍是第三方发行物，适用各自的许可证。上游安装包文件名及 SHA-256 见 [运行时清单](../runtime/portable-runtime.json)；下表按实际随附的版本提供源码。

## 已定位的源码

| 随附组件 | 对应源码和构建资料 | 随附许可 |
| --- | --- | --- |
| CPython 3.13.17 | [Python-3.13.17.tar.xz](https://www.python.org/ftp/python/3.13.17/Python-3.13.17.tar.xz)，含 `PCbuild` 和 [Windows 嵌入版打包工程](https://github.com/python/cpython/blob/v3.13.17/Tools/msi/make_zip.proj) | [Python 许可及第三方声明](../runtime/LICENSE.txt) |
| PyMuPDF 2.1 / MuPDF 1.28.6 | [PyMuPDF 2.1 源码发行物](https://files.pythonhosted.org/packages/13/d9/5ae3cce31a4a62de4f6979331b4d8d5b86a8f2520f06754cf5e69065c887/pymupdf-2.1.tar.gz)，含 `setup.py`；[对应 PyMuPDF 构建提交](https://github.com/pymupdf/PyMuPDF/tree/16c664fd456baca66ba1e72d53922a54fcfc997a)；`setup.py` 固定的 [MuPDF 1.28.6 完整源码发行物](https://mupdf.com/downloads/archive/mupdf-1.28.6-source.tar.gz)。Layout 的对应源码见下节。 | AGPL-3.0 或来自 Artifex 的商业许可；PyMuPDF 包内保留 `COPYING`、`METADATA` |
| PyMuPDF4LLM 2.1 | [对应的源代码及打包提交](https://github.com/pymupdf/PyMuPDF4LLM/tree/030a6b0ac449266a67b79675272fb877a34a87ab)，与随包 `_build.py` 记录一致；随包保留 Python 源文件。单独的 `pymupdf_layout` wheel 是兼容包，不能替代已嵌入 PyMuPDF 的 Layout 源码。 | 保留 `pymupdf4llm-2.1.dist-info/` 中的上游许可 |
| OpenCV 5.0.0.93 | [OpenCV Python Headless 源码发行物](https://files.pythonhosted.org/packages/1d/99/76b7c80252aa83c1af16393454aafd125a0287101afe8deb0a6821af0e30/opencv_python_headless-5.0.0.93.tar.gz)；FFmpeg DLL 对应来源见下节。 | 保留 `cv2/LICENSE.txt`、`cv2/LICENSE-3RD-PARTY.txt` 等随包声明 |
| Shapely 2.2.0 / GEOS 3.14.1 | [Shapely 源码发行物](https://files.pythonhosted.org/packages/f3/ab/924b6e202f796d270a3041a230151f7908db5ea48c74effe6f8023e9bd05/shapely-2.2.0.tar.gz)、[Windows wheel 构建工作流](https://github.com/shapely/shapely/blob/2.2.0/.github/workflows/release.yml)、[GEOS 3.14.1 源码](https://download.osgeo.org/geos/geos-3.14.1.tar.bz2)。实际装载的 `geos*.dll` 报告版本为 3.14.1，与上游构建设置相符。 | Shapely 为 BSD-3-Clause；GEOS 为 LGPL-2.1，保留 `shapely-2.2.0.dist-info/licenses/LICENSE_GEOS` |
| NumPy 2.5.4 / OpenBLAS 0.3.34.106.0 | [NumPy 2.5.4 源码发行物](https://files.pythonhosted.org/packages/95/b0/c7453d0b6e2073c3264468b106ee1563750cecc910965e67357e3698c83e/numpy-2.5.4.tar.gz)；[OpenBLAS 源码提交](https://github.com/OpenMathLib/OpenBLAS/tree/446c436e10450c348169808f1a6b3fae0925c9f7)，[scipy-openblas64 构建提交、补丁和脚本](https://github.com/MacPython/openblas-libs/tree/78fc0eaf6de71d92fd98f74f7e5bfa356a2f83e3)。构建提交取自[上游 wheel 发行证明](https://pypi.org/integrity/scipy-openblas64/0.3.34.106.0/scipy_openblas64-0.3.34.106.0-py3-none-win_amd64.whl/provenance)。Windows GCC 运行库的源码和补丁见下节。 | `numpy-2.5.4.dist-info/licenses/LICENSE.txt` 含 NumPy、OpenBLAS 和捆绑库许可 |
| certifi 2026.10.23 / tqdm 4.70.1 | [certifi 源码发行物](https://files.pythonhosted.org/packages/fd/11/b524cbd9bbdaca58608e4cf4053fd463417549e1959fa8d3aa18319f9555/certifi-2026.10.23.tar.gz)；[tqdm 源码发行物](https://files.pythonhosted.org/packages/0d/ea/b2a5bd54b28a324dae8211928b2d730b6547500342c7e6c6dea08bd0a485/tqdm-4.70.1.tar.gz)。随包亦保留 Python 源文件及 certifi 的证书数据。 | 保留各包随附的 MPL-2.0 等许可 |

### OpenCV 随附的 FFmpeg

`runtime/Lib/site-packages/cv2/opencv_videoio_ffmpeg500_64.dll` 的 MD5 为 `a821a1135251859655090c795af05789`，与 [OpenCV 5.0.0 的二进制下载配置](https://github.com/opencv/opencv/blob/5.0.0/3rdparty/ffmpeg/ffmpeg.cmake) 一致。该配置指定[二进制提交](https://github.com/opencv/opencv_3rdparty/commit/06dc20cad65dc7fcf784f70c95d46750520889a7)。上游在[配对源码提交](https://github.com/opencv/opencv_3rdparty/commit/664c0098dcb47b361f20c1d6a518653c23f5f2b5)明确记录了同一个二进制提交。

- [配对源码归档](https://codeload.github.com/opencv/opencv_3rdparty/tar.gz/664c0098dcb47b361f20c1d6a518653c23f5f2b5)含封装层、构建工具和配置。[上游下载脚本](https://github.com/opencv/opencv_3rdparty/blob/664c0098dcb47b361f20c1d6a518653c23f5f2b5/ffmpeg/download_src.sh)指定以下依赖；只下载封装层归档不足以取得全部源文件。
- 固定版本：[OpenCV 封装层所用提交](https://github.com/opencv/opencv/tree/a0a660fcb1e58a295e6caa6aee64ed4d369b0181)、[FFmpeg n7.1](https://github.com/FFmpeg/FFmpeg/tree/b08d7969c550a804a59511c7b83f2dd8cc0499b8)、[libvpx v1.16.0](https://chromium.googlesource.com/webm/libvpx/+/1024874c5919305883187e2953de8fcb4c3d7fa6)、[libaom v3.14.1](https://aomedia.googlesource.com/aom/+/03087864cf4bea6abb0d28f95cf7843511413d8f)、[Cisco OpenH264 v2.5.0](https://github.com/cisco/openh264/tree/8c7008aeb6335e7d36ab0d9a023a63f82a8eaac0)。
- FFmpeg 的 LGPL 声明保留在 `cv2/LICENSE-3RD-PARTY.txt`。源码链接用来取得相同构建的材料；它们本身不代表已进行 Windows 重建、替换兼容性测试或满足所有再分发条件。

### PyMuPDF Layout 原生扩展

随包 `pymupdf/layout/_build.py` 记录的提交是 `df5af7f65ae5d9a3561c4c35d8836c15f89ace12`，对应 [Artifex 的 Layout 源码](https://github.com/ArtifexSoftware/pymupdf_layout/tree/df5af7f65ae5d9a3561c4c35d8836c15f89ace12)和[固定提交的归档](https://codeload.github.com/ArtifexSoftware/pymupdf_layout/tar.gz/df5af7f65ae5d9a3561c4c35d8836c15f89ace12)。归档内包含 `setup.py`、`pyproject.toml`、`source/tgif/` 下的 C、SWIG 和模型输入，以及 [AGPL-3.0 许可证](https://github.com/ArtifexSoftware/pymupdf_layout/blob/df5af7f65ae5d9a3561c4c35d8836c15f89ace12/LICENSE)。随包的 16 个 ONNX 文件与该归档逐字节相同。

复核该扩展的构建时，把 Layout 检出目录传给 PyMuPDF 的 `PYMUPDF_SETUP_PATH_LAYOUT`，并用 `PYMUPDF_SETUP_PATH_4LLM` 指定上表的 PyMuPDF4LLM 检出目录。随包 `_build.py` 还记录 SWIG 4.5.1。现有 `pymupdf/_tgif.pyd` 的 SHA-256 是 `9480132fe6d17909608a1a3d0fbef3ed63aeed422ddfb305dfbd03974089db1a`。

### NumPy 随附 DLL 的 GCC 及 MinGW 运行库

本地 `numpy.libs/libscipy_openblas64_*.dll` 与 PyPI 的 `scipy-openblas64` 0.3.34.106.0 Windows x64 wheel 中的 DLL 逐字节相同。该 DLL 的 SHA-256 为 `ed4f167a5330424524f45258e7ca2c8d7f03c0cba1f30ee4985553ac1f88ecf8`。两者都保留 `gcc-10.3.0/libgfortran/io/read.c`、`io/unit.c`、`runtime/error.c` 和 MinGW `winpthreads` 的源码路径。

- [OpenBLAS 的 Windows 构建工作流](https://github.com/MacPython/openblas-libs/blob/78fc0eaf6de71d92fd98f74f7e5bfa356a2f83e3/.github/workflows/windows.yml)固定 [Chocolatey 的 `rtools 4.0.0.20220206`](https://community.chocolatey.org/packages/rtools/4.0.0.20220206)，x64 选用 UCRT64，相关作业为 [Windows x64 ILP64](https://github.com/MacPython/openblas-libs/actions/runs/31317225529/job/93254323637)。该软件包指向 [Rtools40 2022-02-06 安装器](https://github.com/r-windows/rtools-installer/releases/tag/2022-02-06)，安装器的源码包含 [UCRT64 的包选择和仓库配置](https://github.com/r-windows/rtools-installer/tree/2022-02-06)。
- GCC 与 `libgfortran`：下载 [GNU GCC 10.3.0 源码](https://gcc.gnu.org/pub/gcc/releases/gcc-10.3.0/gcc-10.3.0.tar.xz)，配合 [Rtools 在该安装器发行前最后更新的 GCC 10.3.0-9804 配方及补丁](https://github.com/r-windows/rtools-ucrt/tree/c5344cc8c7e310ee4eee513b2381af2e75d65cb9/mingw-w64-gcc)。该配方的 GCC 原始归档校验值与下载结果相同。源码含 `libgfortran/`、`libgcc/` 和 GCC Runtime Library Exception；NumPy 的随包 GCC 许可声明也保留。
- Windows 运行库：同一套 [Rtools UCRT 工具链源码、配方和补丁](https://codeload.github.com/r-windows/rtools-ucrt/tar.gz/c5344cc8c7e310ee4eee513b2381af2e75d65cb9)包含 `mingw-w64-winpthreads-git` 和 `mingw-w64-crt-git`，两者固定使用 [MinGW-w64 源码提交](https://github.com/mingw-w64/mingw-w64/tree/acc9b9d9eb63a13d8122cbac4882eb5f4ee2f679)，也可[直接下载该提交的归档](https://codeload.github.com/mingw-w64/mingw-w64/tar.gz/acc9b9d9eb63a13d8122cbac4882eb5f4ee2f679)。

GCC 版本来自分发二进制本身，Rtools 打包补丁来自安装器和发行时间对应的历史配方。本次没有重新编译 Windows DLL，也没有从原构建日志复核 Rtools 子包的安装清单。

### 已校验的源码归档

以下 SHA-256 来自本次获取的上游归档。GitHub 生成的归档若日后压缩格式改变，可用上表固定提交核对源码。

| 归档 | SHA-256 |
| --- | --- |
| `Python-3.13.17.tar.xz` | `6020bd10aff3bf4821be16f088ebb1591beb7b811dcd8fab1da8f7c22a7b27e7` |
| `pymupdf-2.1.tar.gz` | `9ac95f98016e83eafb8f1d786396f9c60e400d559590596e5b2df9eb6384948b` |
| `mupdf-1.28.6-source.tar.gz` | `dc85000640a45d90ca9b77b061f6ca67cce0c4d4fbecf8819647baf573eef101` |
| OpenCV FFmpeg 配对源码归档 | `51d9a7006ae61f623930cf1daf53e253d8db1e3626ce3da3bb43f378cebb42c8` |
| `geos-3.14.1.tar.bz2` | `3c20919cda9a505db07b5216baa980bacdaa0702da715b43f176fb07eff7e716` |
| OpenBLAS 提交归档 | `ddecf3872f66f556aed35dabe9e04e663f014b05052b989288f28fc9a883afe0` |
| Artifex Layout 提交归档 | `9e8fd04454a55ff60ba47c556fa921b4aaae5b8b172732627cd57bb724897f93` |
| `gcc-10.3.0.tar.xz` | `64f404c1a650f27fc33da242e1f2df54952e3963a49e06e73f6940f3223ac344` |
| Rtools UCRT 工具链配方提交归档 | `6540c9aeb9234f7438401257c1aacdeaaee8ef3d3877b14df50319042a1cd12f` |
| MinGW-w64 提交归档 | `774ebdae72b9c514c375eddcf3bb75af4472498cad9ed8b0664f0fe37b7c17bb` |

## 在线分发说明

本页随 `runtime/` 一同保留。在线分发时，应在二进制的下载位置明确给出对应源码入口，并确保源码和适用的构建材料持续可取。AGPL-3.0 第 6(d) 节允许符合条件的其他服务器提供同等访问；各组件的许可条件仍分别适用。

如果公开完整便携目录，FFmpeg 和 GEOS 随包的 LGPL-2.1 条款还规定了在线分发时从同一发布位置提供源码或相应材料的方式。上面的链接用于获取已匹配的上游资料；本仓库未镜像这些源码和构建材料。

## 其他随附声明

- RapidOCR 与 PaddleOCR 模型：保留 [模型版权与许可](../runtime/Lib/site-packages/rapidocr-3.10.0.dist-info/licenses/MODEL_LICENSES.md) 和软件许可。其中所列 OCR 模型与 PyMuPDF Layout 模型是不同的组件。
- Portions of this software are copyright © 2026 The FreeType Project (https://freetype.org). All rights reserved. 随 Pillow 13.0.0 分发的 FreeType 2.14.3 按 FreeType License 提供，完整条款见 `pillow-13.0.0.dist-info/licenses/LICENSE`。
- pypdf、ONNX Runtime、其余 Python 包及 Windows 运行库保留 `runtime/` 内随附的上游许可、`NOTICE`、第三方声明和包元数据。
- README 的演示为合成 PDF 和模拟模型结果，不包含真实论文或个人研究数据。
