/**
 * @fileOverview WA2 library. A set of utilities to support WASM operations
 * for the WebAudio.
 */


/**
 * @namespace WA2
 */
var WA2 = {
  // Basic byte unit of WASM heap. (16 bit = 2 bytes)
  BYTES_PER_UNIT: Uint16Array.BYTES_PER_ELEMENT,

  // Byte per audio sample. (32 bit float)
  BYTES_PER_SAMPLE: Float32Array.BYTES_PER_ELEMENT,

  // The max audio channel on Chrome is 32.
  MAX_CHANNEL_COUNT: 32,

  // WebAudio's render quantum size.
  RENDER_QUANTUM_FRAMES: 128,
};


/**
 * Copy AudioBuffer by a specified channel count.
 * @param  {AudioBuffer} sourceBuffer
 * @param  {AudioBuffer} destinationBuffer
 * @param  {number} channelCount A number of channels to be copied.
 */
WA2.copyAudioBuffer = function(sourceBuffer, destinationBuffer, channelCount) {
  console.assert(channelCount <= sourceBuffer.numberOfChannels);
  console.assert(channelCount <= destinationBuffer.numberOfChannels);

  for (let i = 0; i < channelCount; ++i) {
    destinationBuffer.getChannelData(i).set(sourceBuffer.getChannelData(i));
  }
};


/**
 * A WASM HEAP wrapper for AudioBuffer class. This breaks down the AudioBuffer
 * into an Array of Float32Array for the convinient WASM opearion.
 *
 * @class
 * @dependency Module A WASM module generated by the emscripten glue code.
 */
class HeapAudioBuffer {

  /**
   * @constructor
   * @param  {number} length Buffer frame length.
   * @param  {number} channelCount Number of channels.
   * @param  {number=} maxChannelCount Maximum number of channels.
   * @return {object} HeapAudioBuffer object.
   */
  constructor(length, channelCount, maxChannelCount) {
    console.assert(Module);
    console.assert(0 < channelCount && channelCount <= WA2.MAX_CHANNEL_COUNT);

    this._isInitialized = false;
    this._length = length;
    this._maxChannelCount = maxChannelCount
        ? Math.min(maxChannelCount, WA2.MAX_CHANNEL_COUNT)
        : channelCount;
    this._channelCount = channelCount;
    this._allocateHeap();
    this._isInitialized = true;
  }

  /**
   * Allocates memory in the WASM heap and set up Float32Array views for the
   * channel data.
   *
   * @private
   */
  _allocateHeap() {
    console.assert(!this._isInitialized);

    const channelByteSize = this._length * WA2.BYTES_PER_SAMPLE;
    const dataByteSize = this._channelCount * channelByteSize;
    this._dataPtr = Module._malloc(dataByteSize);
    this._channelData = [];
    for (let i = 0; i < this._channelCount; ++i) {
      let startByteOffset = this._dataPtr + i * channelByteSize
      let endByteOffset = startByteOffset + channelByteSize;
      // Get the actual array index by dividing the byte offset by 2 bytes.
      this._channelData[i] =
          Module.HEAPF32.subarray(startByteOffset >> WA2.BYTES_PER_UNIT,
                                  endByteOffset >> WA2.BYTES_PER_UNIT);
    }
  }

  /**
   * Adapt the current channel count to the new input buffer.
   *
   * @param  {number} newChannelCount The new channel count.
   */
  adaptChannel(newChannelCount) {
    console.assert(this._isInitialized);
    console.assert(newChannelCount < this._maxChannelCount);

    if (this._channelCount !== newChannelCount) {
      this._channelCount = newChannelCount;
    }
  }

  /**
   * Getter for the buffer length in frames.
   *
   * @return {number} Buffer length in frames.
   */
  get length() {
    return this._isInitialized ? this._length : null;
  }

  /**
   * Getter for the number of channels.
   *
   * @return {number} Buffer length in frames.
   */
  get numberOfChannels() {
    return this._isInitialized ? this._channelCount : null;
  }

  /**
   * Getter for the maxixmum number of channels allowed for the instance.
   *
   * @return {number} Buffer length in frames.
   */
  get maxChannelCount() {
    return this._isInitialized ? this._maxChannelCount : null;
  }

  /**
   * Returns a Float32Array object for a given channel index. If the channel
   * index is undefined, it returns the reference to the base array of channel
   * data.
   *
   * @param  {number|undefined} channelIndex Channel index.
   * @return {Float32Array|Array[Float32Array]} a channel data array or an
   * array of channel data.
   */
  getChannelData(channelIndex) {
    console.assert(this._isInitialized);
    console.assert(typeof channelIndex === 'undefined' ||
                   channelIndex < this._channelCount);

    return typeof channelIndex === 'undefined'
        ? this._channelData : this._channelData[channelIndex];
  }

  /**
   * Returns the base address of the allocated memory space in the WASM heap.
   *
   * @return {number} WASM Heap address.
   */
  getHeap() {
    console.assert(this._isInitialized);

    return this._dataPtr;
  }

  /**
   * Frees the allocated memory space in the WASM heap.
   *
   * @return {[type]} [description]
   */
  free() {
    console.assert(this._isInitialized);

    this._isInitialized = false;
    Module._free(this._dataPtr);
    Module._free(this._pointerArrayPtr);
    this._channelData = null;
  }

}  // class HeapAudioBuffer


/**
 * A JS FIFO implementation for the AudioWorklet. 3 assumptions for the
 * simpler operation:
 *  1. the push and the pull operation are done by 128 frames. (Web Audio
 *    API's render quantum size in the speficiation)
 *  2. the channel count of input/output cannot be changed dynamically.
 *    The AudioWorkletNode should be configured with the `.channelCount = k`
 *    (where k is the channel count you want) and
 *    `.channelCountMode = explicit`.
 *  3. This is for the single-thread operation. (obviously)
 *
 * @class
 */
class RingBuffer {

  /**
   * @constructor
   * @param  {number} channelCount Buffer channel count.
   * @param  {number} length Buffer length in frames.
   * @return {RingBuffer}
   */
  constructor(length, channelCount) {
    this._ri = 0;
    this._wi = 0;
    this._framesAvailable = 0;

    this._channelCount = channelCount;
    this._length = length;
    this._channelData = [];
    for (let i = 0; i < this._channelCount; ++i) {
      this._channelData[i] = new Float32Array(length);
    }
  }

  /**
   * Getter for Available frames in buffer.
   *
   * @return {number} Available frames in buffer.
   */
  get framesAvailable() {
    return this._framesAvailable;
  }

  /**
   * Push a sequence of Float32Arrays to buffer.
   *
   * @param  {array} arraySequence A sequence of Float32Arrays.
   */
  push(arraySequence) {
    console.assert(arraySequence.length === this._channelCount);
    console.assert(arraySequence[0].length <= this._length);

    let sourceLength = arraySequence[0].length;

    // Transfer data from the |arraySequence| storage to the internal buffer.
    for (let i = 0; i < sourceLength; ++i) {
      let writeIndex = (this._wi + i) % this._length;
      for (let channel = 0; channel < this._channelCount; ++channel) {
        this._channelData[channel][writeIndex] = arraySequence[channel][i];
      }
    }

    this._wi += sourceLength;
    if (this._wi >= this._length) {
      this._wi = 0;
    }

    // For excessive frames, the buffer will be overwritten.
    this._framesAvailable += sourceLength;
    if (this._framesAvailable > this._length) {
      this._framesAvailable = this._length;
    }
  }

  /**
   * Pull data out of buffer and fill a given sequence of Float32Arrays.
   *
   * @param  {array} arraySequence An array of Float32Arrays.
   */
  pull(arraySequence) {
    console.assert(arraySequence.length === this._channelCount);
    console.assert(arraySequence[0].length <= this._length);

    // If the FIFO is competely empty, do nothing.
    if (this._framesAvailable === 0)
      return;

    let destinationLength = arraySequence[0].length;

    // Transfer data from the internal buffer to the |arraySequence| storage.
    for (let i = 0; i < destinationLength; ++i) {
      let readIndex = (this._ri + i) % this._length;
      for (let channel = 0; channel < this._channelCount; ++channel) {
        arraySequence[channel][i] = this._channelData[channel][readIndex];
      }
    }

    this._ri += destinationLength;
    if (this._ri >= this._length) {
      this._ri = 0;
    }

    this._framesAvailable -= destinationLength;
    if (this._framesAvailable < 0) {
      this._framesAvailable = 0;
    }
  }

}  // class RingBuffer
