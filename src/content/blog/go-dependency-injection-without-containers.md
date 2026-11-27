---
title: "Dependency Injection in Go without the help of convenience containers?"
description: "After a few weeks of Spring Boot's @Autowired magic, how hard is dependency injection in Go without a container? Interfaces, factories, and a lazy container of your own."
date: 2017-12-20
tags: [go, dependency-injection]
original:
  url: https://medium.com/@nvcnvn/how-difficult-for-handle-dependency-injection-in-go-without-the-help-with-container-a3f570a23d62
  site: Medium
---

*I think I need to talk about Java before go with Go on this topic.*

So, last few weeks I have been doing a small project with Java Spring boot. I was quite amazed by the "Annotation"
Oriented Programming. And the best in all of that is the `@Bean` related stuff.

```java
// Car.java
@Service
public class Car {
  public void Move(Destination destination) {}
}
```

```java
// Transporter.java
@Service
public class Transporter {
  @Autowired
  private Car vehicle;

  public void Deliver(Lady prettyOne, Destination to) {
    makeOutWith(prettyOne);
    hitAllTheBadGuysAt(to);
  }

  private void makeOutWith(Lady prettyOne) {
    // ...
  }

  private void hitAllTheBadGuysAt(Destination to) {
    vehicle.Move(to);
    // then full of violence
  }
}
```

Yes, I know that many bad stuffs in my code block (the way I don't use constructor, naming bla bla bla whatever)
**but anyway that code work**, you done your dependency injection may be in a not-perfect-way but still work. *And for
me, this code consider as good for 2 weeks trained guy (honestly I almost forget all the stuff from university).*

For testing, I can make a class extend `Car` then override the `Move` method, inject it by 2 annotations. Now go back
to Go.

```go
type Car struct {}
func (c *Car) Move(to Destination) {}

type Transporter struct {
  vehicle *Car
}

func (t *Transporter) makeOutWith(pretty Lady) {
  // ...
}

func (t *Transporter) hitAllTheBadGuysAt(dest Destination) {
  t.vehicle.Move(dest)
}
```

OK, bad example, bad naming (*somehow I keep thinking about the Transporter movie*)… anyway, that code somewhat
equivalent to 2 Java classes except we still not have any lazy-magic in automatic putting you dependency to
`Transporter`.

But wait, there is a big problem.. the transporter in Go universe can only drive `Car`, he cannot drive a Boat or jet
or a Tank… too bad for comparing the Java guy! (*in Java universe, if we really want, we can provide him a Spaceship
extended Car and tell him that Spaceship can Move to Destination. Then our guy can drive that Spaceship just like
driving a Car… genius!*). Your code cannot be lazy and short as Java anymore, need a bit longer:

```go
type Car struct {}
func (c *Car) Move(to Destination) {}

type Vehicle interface {
  Move(to Destination)
}

type Transporter struct {
  vehicle Vehicle
}

func (t *Transporter) makeOutWith(pretty Lady) {
  // ...
}

func (t *Transporter) hitAllTheBadGuysAt(dest Destination) {
  t.vehicle.Move(dest)
}
```

## And now, how you can lazy inject your dependency

I won't need to write it here, you can find loads of good article already for all sort of container libs you can find
in Go.

BAD NEWS for you guys, the Go libs can help you if you just a little lazy but not a really lazy guy like me. In the
most the convenient DI lib you will found, it always needs kind of:

```go
// init all your component [or maybe doing some weird stuff like get a pointer of a nil interface]
c1 = &Car{}
c2 = &Transporter{}
// put them all in your container
container.MagicStuff(c1, c2)
// and hope it work as you expect
```

- I still not found any libs that can help you config the "struct path" string then inject them depending on env. All
  the "config" do by code. Ofc you can **write that feature for yourself** quite simple.
- All the libs I know need you to handle by **writing more code** if you have 2 components with the same interface and
  you want to inject them. Or if you lucky enough you can find a lib support struct tag that works similar to
  `@Qualifier` but that also you need to write some
- I almost end up to just **write normal code** in some bad case that A need B and B need A.

## My lazy solution: your own lazy container

```go
// factory.go
func main() {
  assasinService := &KindOfAssasinService{}
  transporter := NewTransporter(assasinService)
  hitman := NewHitMan(assasinService);
}

type KindOfAssasinService struct {}
func (ass *KindOfAssasinService) GetVehicle(t string) Vehicle {
  if t == "car" {
    return &Car{}
  }

  return &Tank{}
}

func (ass *KindOfAssasinService) GetWeapon(t string) Weapon {
  if t == "gun" {
    return &Gun{}
  }

  return &Dagger{}
}
```

```go
// hitman.go
type WeaponFactory interface {
  GetWeapon(t string) Weapon
}

type Hitman struct {
  weaponFactory WeaponFactory
}

func (h *Hitman) doHitmanStuff() {
  h.weaponFactory.GetWeapon("gun").KickSomeAss()
}
```

```go
// transporter3.go
type VehicleFactory interface {
  GetVehicle(t string) Vehicle
}

type Transporter struct {
  vehicle Vehicle
}

func (t *Transporter) makeOutWith(pretty Lady) {
  // ...
}

func (t *Transporter) hitAllTheBadGuysAt(dest Destination) {
  t.vehicle.Move(dest)
}

func NewTransporter(f VehicleFactory) *Transporter {
  return &Transporter{
    vehicle: f.GetVehicle("car"),
  }
}
```

OK, not really short but that the best I can come up.

- More code, but anyway you can write all in 1 package for your container and init block in 1 function. Multi ENV can
  be config in a single main file for sure.
- Stuff like Qualifier, Scope not available in a single line of code (or string of struct tag) but you can have all
  your complex condition.
- Testing quite easy already.
