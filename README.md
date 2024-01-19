# hhc2023-crew
A collection of scripts written for the [2023 SANS Holiday Hack Challenge](https://2023.holidayhackchallenge.com/).

## Autofisher ([fish.js](fish.js))
This is a snippet of code for an autofisher. Simply paste into the console, then hit "Cast Line".

## Captain and Crew ([crew.user.js](crew.user.js) / [Install](https://github.com/noodlebox/hhc2023-crew/raw/trunk/crew.user.js))
This is a userscript adding various features and QoL fixes to the sailing mode of Holiday Hack Challenge 2023. You'll most likely need some kind of userscript manager extension (like Violentmonkey). I didn't complete everything I wanted to during the event, but I'm pretty happy with the features I was able to get in. I have some notes about reverse engineering the game mechanics and client code that I may publish after some more cleanup, but I didn't finish a more detailed writeup in time for the event. However, if you have any questions about mechanics or feature requests, feel free to [open an issue](https://github.com/noodlebox/hhc2023-crew/issues/new)!

Current features include:

### Improved rendering performance (about 3-4x on my machine)
- Ship images are cached
- Uses webgl to draw terrain instead of SVG ![image](https://github.com/noodlebox/hhc2023-crew/assets/308464/53bdd11d-17b1-4c93-bd10-c135786689f0)

### Smoother ship handling
- Adds client-side prediction to compensate for network latency
- Interpolates player position between server ticks

### Additional UI features
- Mouse wheel zoom
- Better race UI ![image](https://github.com/noodlebox/hhc2023-crew/assets/308464/4a32e947-8fc2-405f-b134-c22ce5bb0371)
- Seamless map edges ![image](https://github.com/noodlebox/hhc2023-crew/assets/308464/4e114ea7-b6df-40ea-8722-49bddbd5c431)
- `Tab` toggles ~~editor~~ free camera mode ![image](https://github.com/noodlebox/hhc2023-crew/assets/308464/9b3dadd1-0af1-48b4-b7d9-b7d72a22cbc5)
