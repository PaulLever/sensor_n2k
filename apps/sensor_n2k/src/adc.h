#ifndef ADC_H_
#define ADC_H_

/* ADC thread entry — sensor data goes to the SPI bridge, not directly to CAN. */
void adc_thread(void *unused0, void *unused1, void *unused2);

#endif /* ADC_H_ */
