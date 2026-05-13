package tz

import (
	"fmt"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"

	"github.com/nyaruka/phonenumbers"
)

// parsedNumber is the cached result of phonenumbers.Parse.
type parsedNumber struct {
	NPA    string
	NXX    string
	NPAInt uint32 // numeric NPA (e.g. 317)
	NXXInt uint32 // numeric NXX (e.g. 555)
	Key    uint32 // NPA*1000 + NXX
	Type   NumberType
	Raw    *phonenumbers.PhoneNumber
}

// parseLRU is a simple LRU cache for phonenumbers.Parse results.
// Key = E.164 phone string. Capacity 4096.
const parseLRUCap = 4096

type parseLRU struct {
	mu    sync.Mutex
	m     map[string]*lruNode
	head  *lruNode // MRU
	tail  *lruNode // LRU
	count int
}

type lruNode struct {
	key   string
	value parsedNumber
	prev  *lruNode
	next  *lruNode
}

var globalParseLRU = &parseLRU{m: make(map[string]*lruNode, parseLRUCap)}

// get retrieves a cached parsedNumber.
func (l *parseLRU) get(key string) (parsedNumber, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	n, ok := l.m[key]
	if !ok {
		return parsedNumber{}, false
	}
	l.moveToHead(n)
	return n.value, true
}

// set stores a parsedNumber, evicting the LRU entry if at capacity.
func (l *parseLRU) set(key string, v parsedNumber) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if n, ok := l.m[key]; ok {
		n.value = v
		l.moveToHead(n)
		return
	}
	if l.count >= parseLRUCap {
		// evict tail
		delete(l.m, l.tail.key)
		if l.tail.prev != nil {
			l.tail.prev.next = nil
		} else {
			l.head = nil
		}
		l.tail = l.tail.prev
		l.count--
	}
	n := &lruNode{key: key, value: v}
	l.m[key] = n
	l.count++
	if l.head == nil {
		l.head = n
		l.tail = n
		return
	}
	n.next = l.head
	l.head.prev = n
	l.head = n
}

func (l *parseLRU) moveToHead(n *lruNode) {
	if n == l.head {
		return
	}
	if n.prev != nil {
		n.prev.next = n.next
	}
	if n.next != nil {
		n.next.prev = n.prev
	}
	if n == l.tail {
		l.tail = n.prev
	}
	n.prev = nil
	n.next = l.head
	if l.head != nil {
		l.head.prev = n
	}
	l.head = n
}

// parseE164 parses a phone number from E.164 format, extracting NPA and NXX.
// Results are cached in the global LRU.
func parseE164(phone string) (p parsedNumber, err error) {
	if v, ok := globalParseLRU.get(phone); ok {
		return v, nil
	}
	parsed, parseErr := safeParsePhone(phone)
	if parseErr != nil {
		return parsedNumber{}, parseErr
	}

	nat := phonenumbers.GetNationalSignificantNumber(parsed)
	if len(nat) < 10 {
		return parsedNumber{}, fmt.Errorf("tz: national number too short: %q", nat)
	}
	npa := nat[:3]
	nxx := nat[3:6]

	npaInt, _ := strconv.ParseUint(npa, 10, 32)
	nxxInt, _ := strconv.ParseUint(nxx, 10, 32)
	key := uint32(npaInt*1000 + nxxInt)

	nt := goNumberType(phonenumbers.GetNumberType(parsed))

	result := parsedNumber{
		NPA:    npa,
		NXX:    nxx,
		NPAInt: uint32(npaInt),
		NXXInt: uint32(nxxInt),
		Key:    key,
		Type:   nt,
		Raw:    parsed,
	}
	globalParseLRU.set(phone, result)
	return result, nil
}

// safeParsePhone wraps phonenumbers.Parse with a recover() to handle panics
// from malformed input. Panics are counted in vici2_tz_parse_panics_total.
func safeParsePhone(phone string) (pn *phonenumbers.PhoneNumber, err error) {
	defer func() {
		if r := recover(); r != nil {
			tzParsePanics.Inc()
			_ = debug.Stack()
			err = fmt.Errorf("tz: phonenumbers.Parse panic: %v", r)
		}
	}()

	// Normalise: ensure it starts with +
	if !strings.HasPrefix(phone, "+") {
		phone = "+" + phone
	}
	pn, err = phonenumbers.Parse(phone, "US")
	return pn, err
}

// isValidUSZip returns true for 5-digit or XXXXX-XXXX zip codes.
func isValidUSZip(zip string) bool {
	if len(zip) == 5 {
		for _, c := range zip {
			if c < '0' || c > '9' {
				return false
			}
		}
		return true
	}
	if len(zip) == 10 && zip[5] == '-' {
		return isValidUSZip(zip[:5])
	}
	return false
}

// zipKey returns the first 5 digits of a US ZIP as a uint32.
func zipKey(zip string) uint32 {
	z := zip[:5]
	v, _ := strconv.ParseUint(z, 10, 32)
	return uint32(v)
}

// goNumberType converts phonenumbers.PhoneNumberType to our NumberType enum.
func goNumberType(pt phonenumbers.PhoneNumberType) NumberType {
	switch pt {
	case phonenumbers.FIXED_LINE:
		return NumberTypeFixedLine
	case phonenumbers.MOBILE:
		return NumberTypeMobile
	case phonenumbers.FIXED_LINE_OR_MOBILE:
		return NumberTypeFixedOrMobile
	case phonenumbers.TOLL_FREE:
		return NumberTypeTollFree
	case phonenumbers.PREMIUM_RATE:
		return NumberTypePremiumRate
	case phonenumbers.VOIP:
		return NumberTypeVoip
	default:
		return NumberTypeUnknown
	}
}
