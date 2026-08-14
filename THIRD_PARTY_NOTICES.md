# Third-party notices

WavePort includes the prebuilt `spiOverJtag_ep4ce2217.rbf` bridge and adapts
the Altera/USB-Blaster programming sequence from
[openFPGALoader](https://github.com/trabucayre/openFPGALoader).

openFPGALoader is licensed under the Apache License 2.0. Copyright (C) its
respective contributors, including Gwenhael Goavec-Merou.

The bridge is loaded only into volatile FPGA SRAM to provide access to the EPCS
flash during backup, verified bank writing, and emergency recovery. The module
is restarted from its flash configuration after each operation.
