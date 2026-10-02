# Vehicle motion

Stage 1b, 2026-10-01. Primary sources consulted:

- [SUMO car-following models](https://sumo.dlr.de/userdoc/Car-Following-Models/):
  comfortable and emergency braking are distinct; upstream constraints must
  allow sufficient reaction and stopping distance.
- [Treiber's traffic simulation implementation](https://github.com/movsim/traffic-simulation-de/blob/master/README.md):
  ballistic integration advances speed and distance consistently. Handle a
  stop inside a tick without integrating negative velocity.
- [CARLA Ackermann controller](https://carla.org/Doxygen/html/d0/d4d/AckermannController_8h_source.html):
  speed, acceleration and jerk are explicit longitudinal-control quantities.

Measure vehiclePose at every tick, including transfers between lanelets.
Report observed acceleration changes, emergency-limit violations, instant
stops and pose discontinuities before choosing the replacement controller.
Comfort must not disguise collisions or relocate bodies after integration.
The replacement stays optional; integrate remains the sole position writer.
