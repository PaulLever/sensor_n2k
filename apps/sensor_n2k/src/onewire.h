#ifndef ONEWIRE_H_
#define ONEWIRE_H_

/* 1-Wire / DS18B20 thread entry — sensor data goes to the SPI bridge. */
void onewire_thread(void *unused0, void *unused1, void *unused2);

#endif /* ONEWIRE_H_ */
