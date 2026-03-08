# Vehicle-to-Vehicle Convoy Safety Demo

Real-time proof-of-concept for cooperative braking alerts between vehicles.

## Stack

- Node.js
- WebSockets
- Express
- Browser clients acting as cars

## Demo concept

Cars join a convoy room and broadcast:

- speed
- position
- gap to front car
- brake events

Other cars calculate:

- relative speed
- time-to-collision
- danger level

Hard brake events propagate instantly across the convoy.

## Run locally


npm install
npm start


Open:


http://localhost:3000


## Demo

Open multiple tabs / phones:

Car A  
Car B  
Car C  
Car D  

Press **HARD BRAKE** on the lead car to trigger convoy alerts.
