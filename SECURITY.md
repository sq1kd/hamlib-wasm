<!-- SPDX-License-Identifier: MIT -->

# Security

Report a vulnerability privately: on GitHub, open the **Security** tab and
choose **Report a vulnerability**. Please do not open a public issue for it.

Scope: the package only talks to a serial port the user or the application
granted it, and sends what the Hamlib backend for the chosen model sends.
Bugs in Hamlib itself go to [Hamlib upstream](https://github.com/Hamlib/Hamlib),
unless the problem is in how we build, patch or expose it.
